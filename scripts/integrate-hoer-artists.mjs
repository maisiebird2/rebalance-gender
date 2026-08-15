#!/usr/bin/env node
// ============================================================
// integrate-hoer-artists.mjs — Phase D of the HÖR sync rework.
//
// The ONLY script that creates or binds `artists` rows. Operates on unbound,
// already-scraped candidates (hoer_terms where artist_id IS NULL AND scraped_at
// IS NOT NULL) and resolves each one's identity:
//
//   4a — socials match: if the term's staged socials (hoer_term_links) point at
//        a URL an existing artist already holds, that term IS that artist. Bind
//        the term to them and attach the HÖR link. This is how HÖR discovery
//        avoids creating a duplicate of someone we already know.
//   4b — no match: seed a NEW artist, directory_status='pending'.
//
// Binding NEVER changes directory_status — a bind adds a link and nothing else;
// deciding who belongs in the directory is a separate process (many HÖR artists
// are men and don't qualify at all).
//
// Once a term has an artist_id (either path), fan out everything HÖR knows:
// legal name, bio, portrait, socials (staged for integrate-harvested-links),
// and the genres replayed from hoer_sets. Collaborations need no work — they
// are derived from hoer_sets at query time once the term is bound.
//
// Match quality (learned from real Phase C output): only identity-bearing
// platforms count (see MATCH_POOL_PLATFORMS), and a candidate URL must have a
// real path — a bare host like https://bandcamp.com/ would match everyone.
//
// Ambiguous (>1 artist matched) and conflict (matched artist already has a
// different HÖR link) cases are never forced: they're bound-or-skipped per the
// table below and written to dated CSVs for the separate dedup process.
//
// Usage (from the rebalance-gender/ folder):
//   npm run integrate-hoer-artists
//   tsx scripts/integrate-hoer-artists.mjs --limit=100
//   DRY_RUN=1 tsx scripts/integrate-hoer-artists.mjs      # decide + tally, no writes
//   tsx scripts/integrate-hoer-artists.mjs --debug
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import path from "node:path";
import { loadEnvLocal, createSupabase, makeFetchAll } from "./lib/hoer-db.mjs";
import { artistUrl, normalizeUrl } from "./lib/hoer-library.mjs";
import { eligibleMatchLinks, decideOutcome, MATCH_POOL_PLATFORMS } from "./lib/hoer-match.mjs";
import { loadTagMap, stageFanoutForTerms } from "./lib/hoer-fanout.mjs";
import { writeCSV, timestamp } from "./lib/hoer-resolve.mjs";
import { outputPath } from "./lib/output-path.mjs";

const DRY_RUN = process.env.DRY_RUN === "1";
const STATE_SERVICE = "hoer-sync";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
if (limitArg != null && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  console.error(`--limit must be a positive integer (got ${JSON.stringify(limitArg.split("=")[1])}).`);
  process.exit(1);
}

loadEnvLocal();
let supabase;
try {
  supabase = createSupabase();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const fetchAll = makeFetchAll(supabase);

const IS_TTY = Boolean(process.stdout.isTTY);
function progress(msg) {
  if (IS_TTY) process.stdout.write(`\r${msg}\x1b[K`);
  else console.log(msg);
}
function progressDone() {
  if (IS_TTY) process.stdout.write("\n");
}
const CHUNK = 500;

// ------------------------------------------------------------
// Build the match index: `${platform}|${normalizedUrl}` -> Set(artist_id) over
// existing artist_links on the identity-bearing platforms, excluding deleted
// artists. This is what a term's socials are matched against.
// ------------------------------------------------------------
async function loadMatchIndex() {
  const rows = await fetchAll(
    "artist_links",
    "artist_id, platform, url, artists(deleted)",
    (q) => q.in("platform", [...MATCH_POOL_PLATFORMS]),
    "id"
  );
  const index = new Map();
  for (const r of rows) {
    if (r.artists?.deleted || !r.url) continue;
    let norm;
    try {
      norm = normalizeUrl(r.url);
    } catch {
      continue;
    }
    const key = `${r.platform}|${norm}`;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(r.artist_id);
  }
  return index;
}

// artist_id -> existing HÖR link url, NORMALIZED (each artist has at most one).
// Normalized so the "already has a different HÖR link" check doesn't fire on a
// mere trailing-slash difference — old links are stored as …/slug, artistUrl()
// produces …/slug/.
async function loadHoerLinks() {
  const rows = await fetchAll("artist_links", "artist_id, url", (q) => q.eq("platform", "hoer"), "id");
  const map = new Map();
  for (const r of rows) {
    if (map.has(r.artist_id) || !r.url) continue;
    let norm;
    try {
      norm = normalizeUrl(r.url);
    } catch {
      norm = r.url;
    }
    map.set(r.artist_id, norm);
  }
  return map;
}

// term_id -> [hoer_term_links rows] for the candidate terms.
async function loadTermLinks(termIds) {
  const map = new Map();
  for (let i = 0; i < termIds.length; i += CHUNK) {
    const chunk = termIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("hoer_term_links")
      .select("term_id, raw_url, parsed_platform, parsed_url")
      .in("term_id", chunk);
    if (error) throw new Error(`couldn't read hoer_term_links: ${error.message}`);
    for (const r of data ?? []) {
      if (!map.has(r.term_id)) map.set(r.term_id, []);
      map.get(r.term_id).push(r);
    }
  }
  return map;
}

// ------------------------------------------------------------
// Per-term fan-out that isn't genre/bio (those are batch-replayed after the
// loop by stageFanoutForTerms). legal name, portrait, staged socials, resolved.
// ------------------------------------------------------------
async function fanoutTerm(term, artistId) {
  const src = artistUrl(term.slug);

  const legal = [term.first_name, term.last_name].filter((x) => x && x.trim()).join(" ").trim();
  if (legal) {
    await supabase
      .from("artist_legal_names")
      .upsert({ artist_id: artistId, platform: "hoer", legal_name: legal, source_url: src }, { onConflict: "artist_id,platform" });
  }

  if (term.image_url) {
    await supabase.from("artist_images").upsert(
      { artist_id: artistId, platform: "hoer", source_url: term.image_url, fetched_at: new Date().toISOString() },
      { onConflict: "artist_id,platform" }
    );
  }

  const links = term.links ?? [];
  if (links.length) {
    const rows = links.map((l) => ({
      artist_id: artistId,
      source_platform: "hoer",
      source_url: src,
      raw_url: l.raw_url,
      parsed_platform: l.parsed_platform,
      parsed_url: l.parsed_url,
    }));
    await supabase
      .from("artist_harvested_links")
      .upsert(rows, { onConflict: "artist_id,parsed_url", ignoreDuplicates: true });
  }

  await supabase
    .from("resolved_artists")
    .upsert({ artist_id: artistId, service: STATE_SERVICE, resolved_at: new Date().toISOString() }, { onConflict: "artist_id,service" });
}

async function bindTerm(termId, artistId, method) {
  const { error } = await supabase
    .from("hoer_terms")
    .update({ artist_id: artistId, bind_method: method, bound_at: new Date().toISOString() })
    .eq("term_id", termId);
  if (error) throw new Error(`bind failed for term ${termId}: ${error.message}`);
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(DRY_RUN ? "integrate-hoer-artists — DRY RUN (no writes)\n" : "integrate-hoer-artists\n");

  // Candidates: unbound, already scraped.
  let candidates = await fetchAll(
    "hoer_terms",
    "term_id, slug, display_name, first_name, last_name, bio, image_url",
    (q) => q.is("artist_id", null).not("scraped_at", "is", null),
    "term_id"
  );
  const found = candidates.length;
  if (LIMIT) candidates = candidates.slice(0, LIMIT);
  console.log(`Phase D: ${candidates.length} unbound, scraped term(s)${LIMIT && found > LIMIT ? ` (of ${found})` : ""}.`);
  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const [matchIndex, hoerLinks, termLinks] = await Promise.all([
    loadMatchIndex(),
    loadHoerLinks(),
    loadTermLinks(candidates.map((c) => c.term_id)),
  ]);

  const stats = { bind: 0, seed: 0, ambiguous: 0, conflict: 0, failed: 0 };
  const boundTermIds = [];
  const conflictRows = [];
  const ambiguousRows = [];

  let done = 0;
  for (const term of candidates) {
    if (++done % 25 === 0 || done === candidates.length)
      progress(`  resolving… ${done}/${candidates.length} — ${stats.seed} seeded, ${stats.bind} bound, ${stats.ambiguous} ambiguous`);

    term.links = termLinks.get(term.term_id) ?? [];
    const eligible = eligibleMatchLinks(term.links);
    const matched = [];
    for (const l of eligible) {
      const hits = matchIndex.get(`${l.parsed_platform}|${l.parsed_url}`);
      if (hits) for (const id of hits) matched.push(id);
    }
    const outcome = decideOutcome(matched);

    if (outcome.type === "ambiguous") {
      stats.ambiguous++;
      ambiguousRows.push({
        term_id: term.term_id,
        slug: term.slug,
        display_name: term.display_name ?? "",
        matched_artist_ids: outcome.artistIds.join(" "),
        matched_via: eligible.map((l) => l.parsed_url).join(" "),
      });
      if (DEBUG) console.log(`? ${term.slug}: ambiguous (${outcome.artistIds.length} artists)`);
      continue;
    }

    if (DRY_RUN) {
      if (outcome.type === "bind") stats.bind++;
      else stats.seed++;
      if (DEBUG)
        console.log(`~ ${term.slug}: would ${outcome.type === "bind" ? `bind → ${outcome.artistId}` : "seed new"}`);
      continue;
    }

    try {
      let artistId;
      let method;
      if (outcome.type === "bind") {
        artistId = outcome.artistId;
        method = "social_match";
      } else {
        const name = (term.display_name && term.display_name.trim()) || term.slug;
        const { data: inserted, error } = await supabase
          .from("artists")
          .insert({ name, directory_status: "pending" })
          .select("id")
          .single();
        if (error || !inserted) throw new Error(`seed insert failed: ${error?.message ?? "no row"}`);
        artistId = inserted.id;
        method = "seeded_new";
      }

      // Attach the HÖR link, unless the (matched) artist already has one.
      // Compare normalized (existingHoer is already normalized) so a trailing
      // slash doesn't read as a different link.
      const existingHoer = hoerLinks.get(artistId);
      const thisUrl = artistUrl(term.slug);
      const thisUrlNorm = normalizeUrl(thisUrl);
      if (existingHoer == null) {
        const { error } = await supabase
          .from("artist_links")
          .insert({ artist_id: artistId, platform: "hoer", url: thisUrl, handle: term.slug });
        if (error) throw new Error(`hoer link insert failed: ${error.message}`);
        hoerLinks.set(artistId, thisUrlNorm); // so a later term binding the same artist sees it
      } else if (existingHoer !== thisUrlNorm) {
        stats.conflict++;
        conflictRows.push({
          term_id: term.term_id,
          slug: term.slug,
          artist_id: artistId,
          this_hoer_url: thisUrl,
          existing_hoer_url: existingHoer,
        });
      }

      await bindTerm(term.term_id, artistId, method);
      await fanoutTerm(term, artistId);
      boundTermIds.push(term.term_id);
      if (outcome.type === "bind") stats.bind++;
      else stats.seed++;
      if (DEBUG) console.log(`✓ ${term.slug}: ${method} → ${artistId}`);
    } catch (err) {
      stats.failed++;
      console.error(`  (${term.slug}: ${err.message})`);
    }
  }
  progressDone();

  // Batch genre + bio replay for everything bound this run.
  if (!DRY_RUN && boundTermIds.length) {
    const tagMap = await loadTagMap();
    const { genres, bios } = await stageFanoutForTerms(supabase, boundTermIds, tagMap);
    console.log(`  Fan-out for ${boundTermIds.length} bound term(s): ${genres} genre row(s), ${bios} bio(s).`);
  }

  // Review CSVs (dated, in the output folder), same convention as the other
  // hoer scripts — see documentation/OUTPUT-FILE-LOCATION-PROPOSAL.md.
  const stamp = timestamp();
  if (!DRY_RUN && conflictRows.length) {
    const p = writeCSV(
      outputPath(`hoer-bind-conflicts-${stamp}.csv`),
      ["term_id", "slug", "artist_id", "this_hoer_url", "existing_hoer_url"],
      conflictRows
    );
    console.log(`  ${conflictRows.length} conflict(s) → ${path.basename(p)}`);
  }
  if (!DRY_RUN && ambiguousRows.length) {
    const p = writeCSV(
      outputPath(`hoer-bind-ambiguous-${stamp}.csv`),
      ["term_id", "slug", "display_name", "matched_artist_ids", "matched_via"],
      ambiguousRows
    );
    console.log(`  ${ambiguousRows.length} ambiguous → ${path.basename(p)}`);
  }

  console.log(
    `Phase D result${DRY_RUN ? " [dry]" : ""}: ${stats.seed} seeded, ${stats.bind} bound (social match), ` +
      `${stats.ambiguous} ambiguous (skipped), ${stats.conflict} HÖR-link conflict(s), ${stats.failed} failure(s).`
  );
}

main().catch((err) => {
  console.error("\nintegrate-hoer-artists failed:", err?.message ?? err);
  process.exit(1);
});
