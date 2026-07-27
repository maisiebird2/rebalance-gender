#!/usr/bin/env node
// ============================================================
// seed-hoer-terms.mjs — Phase B of the HÖR sync rework.
//
// Consumes the library ledger (hoer_sets rows with processed_at IS NULL) and
// registers the artists credited on those sets into hoer_terms — HÖR's
// identity space, keyed on the ppma_author TERM id. It creates NO `artists`
// rows: a term starts life UNBOUND (artist_id null), an candidate awaiting the
// socials match in Phase D (integrate-hoer-artists.mjs). See
// scripts/HOER-SYNC-REWORK-PLAN.md.
//
// Everything a term needs is inline in the set's `authors` payload (slug,
// display/first/last name, bio, user id, guest flag) — so in the normal case
// this phase makes NO per-artist network calls. It only hits the HÖR API for:
//   • the tag map (/tags, 122 terms, 2 pages) — to name genre tags, and
//   • a fallback: any term id referenced by a set whose `authors` array was
//     absent is resolved via ppma_author?include= in batches of 100.
//
// For terms ALREADY bound (artist_id set — e.g. by a prior --backfill-terms or
// Phase D run) it fans out the set data it now can:
//   • genres → artist_harvested_genres (source_platform='hoer')
//   • bio    → biographies + artist_harvested_bios (platform='hoer')
// Unbound terms' genres/bio wait for Phase D to stage on binding.
//
// Collaborations are NOT written anywhere — they are derived from hoer_sets at
// query time (count distinct sets crediting both artists' terms), so there is
// no counter to keep idempotent. Every write here IS idempotent, so Phase A's
// deliberate rewind / modified_after re-reads are safe.
//
// --backfill-terms: a one-off rollout mode. Binds the existing HÖR-linked
// artists to their term by matching artist_links.handle → hoer_terms.slug,
// setting artist_id / bind_method='backfill'. Requires the ledger to have been
// seeded (so the terms exist) and a normal run to have populated hoer_terms.
//
// Usage (from the rebalance-gender/ folder):
//   npm run seed-hoer-terms                       # consume unprocessed sets
//   tsx scripts/seed-hoer-terms.mjs --limit=200   # cap sets (testing)
//   tsx scripts/seed-hoer-terms.mjs --backfill-terms   # one-off: bind existing artists
//   DRY_RUN=1 tsx scripts/seed-hoer-terms.mjs     # read + log, no writes
//   tsx scripts/seed-hoer-terms.mjs --debug       # verbose
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { loadEnvLocal, createSupabase, makeFetchAll } from "./lib/hoer-db.mjs";
import { hoerJson } from "./lib/hoer-http.mjs";
import { artistUrl } from "./lib/hoer-library.mjs";
import {
  termUpsertFromAuthor,
  termUpsertFromPpmaTerm,
  distinctTermIds,
  buildAuthorIndex,
  genreStageRows,
  slugFromArtistUrl,
} from "./lib/hoer-seed.mjs";
import { loadTagMap, loadBoundTerms, stageFanoutForTerms } from "./lib/hoer-fanout.mjs";

const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const BACKFILL_TERMS = args.includes("--backfill-terms");
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

// ------------------------------------------------------------
// Compact progress (rewrite one line on a TTY, fresh lines when piped).
// ------------------------------------------------------------
const IS_TTY = Boolean(process.stdout.isTTY);
function progress(msg) {
  if (IS_TTY) process.stdout.write(`\r${msg}\x1b[K`);
  else console.log(msg);
}
function progressDone() {
  if (IS_TTY) process.stdout.write("\n");
}

const CHUNK = 500;

// term ids that already have a hoer_terms row (to report new vs. refreshed).
async function loadExistingTermIds(termIds) {
  const set = new Set();
  for (let i = 0; i < termIds.length; i += CHUNK) {
    const chunk = termIds.slice(i, i + CHUNK);
    const { data, error } = await supabase.from("hoer_terms").select("term_id").in("term_id", chunk);
    if (error) throw new Error(`couldn't read existing term ids: ${error.message}`);
    for (const r of data ?? []) set.add(r.term_id);
  }
  return set;
}

// ============================================================
// Normal mode — consume unprocessed sets.
// ============================================================
async function seedFromLedger() {
  // 1. Unprocessed sets, oldest first.
  let sets = await fetchAll(
    "hoer_sets",
    "post_id, post_date, term_ids, tag_ids, authors",
    (q) => q.is("processed_at", null),
    "post_id"
  );
  sets.sort((a, b) => String(a.post_date).localeCompare(String(b.post_date)));
  if (LIMIT) sets = sets.slice(0, LIMIT);

  console.log(`Phase B: ${sets.length} unprocessed set(s) to consume${LIMIT ? ` (--limit=${LIMIT})` : ""}.`);
  if (sets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // 2. Distinct terms + their inline author objects.
  const termIds = distinctTermIds(sets);
  const authorIndex = buildAuthorIndex(sets);
  const seenAt = new Date().toISOString();

  const termRows = [];
  const missing = [];
  for (const tid of termIds) {
    const author = authorIndex.get(tid);
    const row = author ? termUpsertFromAuthor(author, seenAt) : null;
    if (row) termRows.push(row);
    else missing.push(tid);
  }

  // 3. Fallback for term ids with no inline author (authors array absent).
  let fallbackResolved = 0;
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const { ok, data } = await hoerJson(
      `/wp-json/wp/v2/ppma_author?include=${chunk.join(",")}&per_page=100&_fields=id,slug,name`
    );
    if (!ok || !Array.isArray(data)) {
      console.error(`  (fallback ppma_author lookup failed for ${chunk.length} term(s))`);
      continue;
    }
    for (const term of data) {
      const row = termUpsertFromPpmaTerm(term, seenAt);
      if (row) {
        termRows.push(row);
        fallbackResolved++;
      }
    }
  }
  console.log(
    `  ${termIds.length} distinct term(s): ${authorIndex.size} from inline authors, ` +
      `${fallbackResolved} via fallback lookup` +
      (missing.length - fallbackResolved > 0 ? `, ${missing.length - fallbackResolved} unresolved` : "") +
      "."
  );

  const existingTermIds = DRY_RUN ? new Set() : await loadExistingTermIds(termIds);
  const newTerms = termRows.filter((r) => !existingTermIds.has(r.term_id)).length;

  if (DRY_RUN) {
    console.log(`  [dry] would upsert ${termRows.length} hoer_terms row(s).`);
  } else {
    // 4. Upsert hoer_terms (identity fields only — bindings preserved).
    let upserted = 0;
    for (let i = 0; i < termRows.length; i += CHUNK) {
      const chunk = termRows.slice(i, i + CHUNK);
      const { error } = await supabase.from("hoer_terms").upsert(chunk, { onConflict: "term_id" });
      if (error) console.error(`  (hoer_terms upsert chunk at ${i} failed: ${error.message})`);
      else upserted += chunk.length;
    }
    console.log(`  Upserted ${upserted} hoer_terms row(s) — ${newTerms} new, ${upserted - newTerms} refreshed.`);
  }

  // 5. Fan out for terms that are already bound.
  const tagMap = await loadTagMap();
  const boundTerms = await loadBoundTerms(supabase, termIds); // term_id -> { artist_id, bio, slug }
  const termToArtist = new Map([...boundTerms].map(([tid, r]) => [tid, r.artist_id]));

  // 5a. Genres.
  const genreRows = genreStageRows(sets, termToArtist, tagMap);
  let stagedGenres = 0;
  if (!DRY_RUN && genreRows.length) {
    for (let i = 0; i < genreRows.length; i += CHUNK) {
      const chunk = genreRows.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("artist_harvested_genres")
        .upsert(chunk, { onConflict: "artist_id,source_platform,raw_tag", ignoreDuplicates: true });
      if (error) console.error(`  (genre stage chunk failed: ${error.message})`);
      else stagedGenres += chunk.length;
    }
  }

  // 5b. Bio, for bound terms that have one.
  let bios = 0;
  if (!DRY_RUN) {
    for (const [, r] of boundTerms) {
      if (!r.bio) continue;
      const src = artistUrl(r.slug);
      const { error: bErr } = await supabase
        .from("biographies")
        .upsert({ artist_id: r.artist_id, platform: "hoer", bio: r.bio, source_url: src }, { onConflict: "artist_id,platform" });
      if (bErr) {
        console.error(`  (bio upsert failed for ${r.artist_id}: ${bErr.message})`);
        continue;
      }
      await supabase
        .from("artist_harvested_bios")
        .upsert(
          { artist_id: r.artist_id, source_platform: "hoer", source_url: src, raw_bio: r.bio },
          { onConflict: "artist_id,source_platform" }
        );
      bios++;
    }
  }

  console.log(
    `  Bound-term fan-out: ${boundTerms.size} bound term(s) in batch → ` +
      `${DRY_RUN ? genreRows.length + " genre row(s) (dry)" : stagedGenres + " genre row(s) staged"}, ` +
      `${DRY_RUN ? "bio skipped (dry)" : bios + " bio(s)"}.`
  );

  // 6. Stamp processed_at on the consumed sets.
  if (!DRY_RUN) {
    const now = new Date().toISOString();
    const postIds = sets.map((s) => s.post_id);
    let stamped = 0;
    for (let i = 0; i < postIds.length; i += CHUNK) {
      const chunk = postIds.slice(i, i + CHUNK);
      const { error } = await supabase.from("hoer_sets").update({ processed_at: now }).in("post_id", chunk);
      if (error) console.error(`  (processed_at stamp chunk at ${i} failed: ${error.message})`);
      else stamped += chunk.length;
    }
    console.log(`  Marked ${stamped} set(s) processed.`);
  }

  console.log(
    "\nNext: enrich-hoer-terms.mjs (Phase C) scrapes portrait + socials for terms with scraped_at null."
  );
}

// ============================================================
// --backfill-terms — bind existing HÖR-linked artists to their term.
// ============================================================
async function backfillTerms() {
  console.log("Phase B --backfill-terms: binding existing HÖR-linked artists to their term by slug.\n");

  // Existing HÖR links → slug -> [artist_id]. A slug claimed by >1 artist is a
  // conflict we don't auto-resolve.
  const links = await fetchAll("artist_links", "artist_id, handle, url", (q) => q.eq("platform", "hoer"));
  const slugToArtists = new Map();
  for (const l of links) {
    const slug = (l.handle || slugFromArtistUrl(l.url) || "").toLowerCase();
    if (!slug) continue;
    if (!slugToArtists.has(slug)) slugToArtists.set(slug, new Set());
    slugToArtists.get(slug).add(l.artist_id);
  }

  // Terms → slug -> [{ term_id, artist_id }]. Built from the seeded ledger.
  const terms = await fetchAll("hoer_terms", "term_id, slug, artist_id", (q) => q, "term_id");
  const slugToTerms = new Map();
  for (const t of terms) {
    const slug = (t.slug || "").toLowerCase();
    if (!slug) continue;
    if (!slugToTerms.has(slug)) slugToTerms.set(slug, []);
    slugToTerms.get(slug).push(t);
  }

  const stats = { bound: 0, already: 0, unmatched: 0, ambiguousTerm: 0, conflictArtist: 0 };
  const boundTermIds = [];
  const now = new Date().toISOString();

  for (const [slug, artistSet] of slugToArtists) {
    if (artistSet.size > 1) {
      stats.conflictArtist++;
      if (DEBUG) console.log(`  ! ${slug}: ${artistSet.size} artists claim this HÖR slug — skipped`);
      continue;
    }
    const artistId = [...artistSet][0];
    const cand = slugToTerms.get(slug) ?? [];
    if (cand.length === 0) {
      stats.unmatched++;
      if (DEBUG) console.log(`  · ${slug}: no term seeded (its sets predate the ledger window?)`);
      continue;
    }
    const unbound = cand.filter((t) => t.artist_id == null);
    const alreadyBound = cand.filter((t) => t.artist_id === artistId);
    if (alreadyBound.length && !unbound.length) {
      stats.already++;
      continue;
    }
    if (unbound.length > 1) {
      stats.ambiguousTerm++;
      if (DEBUG) console.log(`  ? ${slug}: ${unbound.length} unbound terms share this slug — skipped`);
      continue;
    }
    if (unbound.length === 0) {
      // bound, but to a different artist → leave it, report as conflict
      stats.conflictArtist++;
      if (DEBUG) console.log(`  ! ${slug}: term already bound to a different artist — skipped`);
      continue;
    }
    const term = unbound[0];
    if (DRY_RUN) {
      stats.bound++;
      if (DEBUG) console.log(`  ~ would bind term ${term.term_id} (${slug}) → ${artistId}`);
      continue;
    }
    const { error } = await supabase
      .from("hoer_terms")
      .update({ artist_id: artistId, bind_method: "backfill", bound_at: now })
      .eq("term_id", term.term_id);
    if (error) {
      console.error(`  (bind failed for term ${term.term_id} / ${slug}: ${error.message})`);
      continue;
    }
    stats.bound++;
    boundTermIds.push(term.term_id);
    if (stats.bound % 50 === 0) progress(`  Binding… ${stats.bound}`);
  }
  progressDone();

  // Bind-time fan-out: the sets crediting these terms were already processed
  // by a normal run while the term was still unbound, so their genres/bio were
  // never staged. Replay them now (idempotent).
  if (!DRY_RUN && boundTermIds.length) {
    const tagMap = await loadTagMap();
    const { genres, bios } = await stageFanoutForTerms(supabase, boundTermIds, tagMap);
    console.log(`  Fan-out for ${boundTermIds.length} newly bound term(s): ${genres} genre row(s), ${bios} bio(s).`);
  }

  console.log(
    `Backfill result${DRY_RUN ? " [dry]" : ""}: ${stats.bound} bound, ${stats.already} already bound, ` +
      `${stats.unmatched} unmatched (no seeded term), ${stats.ambiguousTerm} ambiguous term, ` +
      `${stats.conflictArtist} artist/term conflict.`
  );
  if (stats.unmatched > 0) {
    console.log(
      `  ${stats.unmatched} existing artist(s) have no seeded term — seed the ledger further back ` +
        `(harvest-hoer-library --from=<earlier>) so their sets are present, then re-run.`
    );
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(DRY_RUN ? "seed-hoer-terms — DRY RUN (no writes)\n" : "seed-hoer-terms\n");
  if (BACKFILL_TERMS) await backfillTerms();
  else await seedFromLedger();
}

main().catch((err) => {
  console.error("\nseed-hoer-terms failed:", err?.message ?? err);
  process.exit(1);
});
