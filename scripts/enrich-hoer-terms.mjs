#!/usr/bin/env node
// ============================================================
// enrich-hoer-terms.mjs — Phase C of the HÖR sync rework.
//
// The only HTML scrape in the new pipeline, and the only per-artist network
// cost. For every HÖR term not yet scraped (hoer_terms.scraped_at IS NULL) it
// fetches /artist/<slug>/ ONCE and harvests the only two things not already
// available from the posts feed:
//
//   • portrait → hoer_terms.image_url            (store-images.mjs re-hosts on bind)
//   • socials  → hoer_term_links (staged by term_id, pre-identity)
//
// Name / bio / legal name / genres all come from the posts feed (Phase B), so
// this page is NOT fetched for them, and the /wp-json/wp/v2/users/<id> bio call
// the old sync-hoer made is gone. The full parse (stage name, wp user id,
// location, …) is parked in api_response_cache ('hoer-artist', key=slug) for
// later mining.
//
// Socials are staged against the TERM, not an artist — the artist may not exist
// yet. Phase D (integrate-hoer-artists.mjs) matches these against artist_links
// to bind a term to an existing artist or seed a new pending one.
//
// Convergence is hoer_terms.scraped_at: set on success AND on a definitive 404
// (dead/guest page → converge, don't retry forever). A transient failure leaves
// it null so the next run retries. harvest_failures/resolved_artists can't key
// an unbound term (both need an artist_id), so scraped_at is the universal
// signal; harvest_failures is written only as an audit for already-bound terms.
//
// Usage (from the rebalance-gender/ folder):
//   npm run enrich-hoer-terms                       # every unscraped term
//   tsx scripts/enrich-hoer-terms.mjs --limit=200   # bound the run
//   tsx scripts/enrich-hoer-terms.mjs --approved    # bound terms: approved only (unbound always scraped)
//   tsx scripts/enrich-hoer-terms.mjs --force       # re-scrape already-done terms
//   tsx scripts/enrich-hoer-terms.mjs --name=gmoz   # only terms whose name/slug matches
//   DRY_RUN=1 tsx scripts/enrich-hoer-terms.mjs     # fetch + log, no writes
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { loadEnvLocal, createSupabase, makeFetchAll } from "./lib/hoer-db.mjs";
import { hoerFetch } from "./lib/hoer-http.mjs";
import { artistUrl, normalizeUrl } from "./lib/hoer-library.mjs";
import { parseArtistPage } from "./lib/hoer-page.mjs";
import { recordFailure, clearFailure } from "./lib/harvest-failures.mjs";
import { canonicalizeResidentAdvisorUrl } from "../src/lib/profile-links.js";
import { classifyPlatformUrl, CLASSIFY_CONFIGS } from "../src/lib/classify-platform-url.js";

const DRY_RUN = process.env.DRY_RUN === "1";
const STATE_SERVICE = "hoer-sync"; // harvest_failures.service (bound terms only)

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const FORCE = args.includes("--force");
const APPROVED_ONLY = args.includes("--approved");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length).toLowerCase() : null;
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

// ------------------------------------------------------------
// URL classification for staged socials (copied from sync-hoer.mjs — shared
// domain table + CLASSIFY_CONFIGS.hoer, which skips HÖR self-links and YouTube).
// ------------------------------------------------------------
function classifyUrl(rawUrl) {
  rawUrl = canonicalizeResidentAdvisorUrl(rawUrl);
  const platform = classifyPlatformUrl(rawUrl, CLASSIFY_CONFIGS.hoer);
  if (!platform) return null;
  return { platform, parsedUrl: normalizeUrl(new URL(rawUrl)) };
}

// ------------------------------------------------------------
// Build the target list from hoer_terms (+ embedded artist for --approved).
// ------------------------------------------------------------
async function loadTargets() {
  const rows = await fetchAll(
    "hoer_terms",
    "term_id, slug, display_name, artist_id, scraped_at, artists(directory_status, deleted)",
    (q) => (FORCE ? q : q.is("scraped_at", null)),
    "term_id"
  );
  const targets = [];
  for (const r of rows) {
    if (!r.slug) continue;
    const bound = r.artist_id != null;
    // A term bound to a deleted artist: skip (it'll re-bind via Phase D later).
    if (bound && r.artists?.deleted) continue;
    // --approved gates ONLY bound terms; unbound candidates are always scraped
    // (discovering new artists is the point of reading HÖR).
    if (APPROVED_ONLY && bound && r.artists?.directory_status !== "approved") continue;
    if (
      NAME_FILTER &&
      !(r.display_name ?? "").toLowerCase().includes(NAME_FILTER) &&
      !(r.slug ?? "").toLowerCase().includes(NAME_FILTER)
    )
      continue;
    targets.push({ termId: r.term_id, slug: r.slug, artistId: r.artist_id });
  }
  return targets;
}

// ------------------------------------------------------------
// Per-term writes. Returns true on full success.
// ------------------------------------------------------------
async function writeTerm(t, parsed) {
  let ok = true;
  const fail = (label, err) => {
    ok = false;
    console.error(`  (${t.slug}: ${label} failed: ${err?.message ?? err})`);
  };

  // Portrait → hoer_terms.image_url.
  if (parsed.imageUrl) {
    const { error } = await supabase
      .from("hoer_terms")
      .update({ image_url: parsed.imageUrl })
      .eq("term_id", t.termId);
    if (error) fail("image_url", error);
  }

  // Socials → hoer_term_links (classified, deduped by parsed_url).
  const rows = [];
  const seen = new Set();
  for (const rawUrl of parsed.socials) {
    const c = classifyUrl(rawUrl);
    if (!c || seen.has(c.parsedUrl)) continue;
    seen.add(c.parsedUrl);
    rows.push({
      term_id: t.termId,
      raw_url: rawUrl,
      parsed_platform: c.platform,
      parsed_url: c.parsedUrl,
    });
  }
  if (rows.length) {
    const { error } = await supabase
      .from("hoer_term_links")
      .upsert(rows, { onConflict: "term_id,parsed_url", ignoreDuplicates: true });
    if (error) fail("hoer_term_links", error);
  }

  // Durable blob → api_response_cache ('hoer-artist', key = slug).
  const { error: cacheErr } = await supabase.from("api_response_cache").upsert(
    {
      namespace: "hoer-artist",
      cache_key: t.slug,
      payload: {
        slug: t.slug,
        term_id: t.termId,
        canonical_url: artistUrl(t.slug),
        extracted: {
          stageName: parsed.stageName ?? null,
          imageUrl: parsed.imageUrl ?? null,
          socials: parsed.socials,
          location: parsed.location ?? null,
          wpUserId: parsed.wpUserId ? Number(parsed.wpUserId) : null,
        },
      },
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "namespace,cache_key" }
  );
  if (cacheErr) fail("cache blob", cacheErr);

  return { ok, staged: rows.length };
}

async function markScraped(termId) {
  const { error } = await supabase
    .from("hoer_terms")
    .update({ scraped_at: new Date().toISOString() })
    .eq("term_id", termId);
  if (error) console.error(`  (failed to stamp scraped_at for term ${termId}: ${error.message})`);
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(DRY_RUN ? "enrich-hoer-terms — DRY RUN (no writes)\n" : "enrich-hoer-terms\n");

  let targets = await loadTargets();
  const found = targets.length;
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(
    `Phase C: ${targets.length} term page(s) to scrape` +
      (LIMIT && found > LIMIT ? ` (of ${found}; --limit=${LIMIT})` : "") +
      (APPROVED_ONLY ? ", approved-bound + all unbound" : "") +
      (FORCE ? ", --force (re-scraping done terms)" : "") +
      "."
  );
  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const stats = { ok: 0, images: 0, links: 0, noImage: 0, failed: 0 };
  let done = 0;
  for (const t of targets) {
    if (++done % 10 === 0 || done === targets.length)
      progress(`  scraping… ${done}/${targets.length} — ${stats.ok} ok, ${stats.images} img, ${stats.failed} failed`);

    const pageUrl = artistUrl(t.slug);
    let res;
    try {
      res = await hoerFetch(pageUrl);
    } catch {
      res = null;
    }

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      const is404 = status === 404;
      stats.failed++;
      if (DEBUG || !is404) console.log(`✗ ${t.slug}: HÖR HTTP ${status}${is404 ? " (converging)" : " (will retry)"}`);
      if (!DRY_RUN) {
        if (t.artistId) {
          await recordFailure(supabase, {
            artistId: t.artistId,
            service: STATE_SERVICE,
            status: is404 ? "page_404" : "fetch_failed",
            detail: `HÖR HTTP ${status}`,
            url: pageUrl,
          });
        }
        if (is404) await markScraped(t.termId); // definitive dead page → converge
      }
      continue;
    }

    const html = await res.text();
    const parsed = parseArtistPage(html);
    if (parsed.imageUrl) stats.images++;
    else stats.noImage++;

    if (DRY_RUN) {
      stats.ok++;
      if (DEBUG)
        console.log(
          `~ ${t.slug}: image=${parsed.imageUrl ? "yes" : "no"}, socials=${parsed.socials.length}`
        );
      continue;
    }

    const { ok, staged } = await writeTerm(t, parsed);
    if (ok) {
      stats.links += staged;
      await markScraped(t.termId);
      if (t.artistId) await clearFailure(supabase, { artistId: t.artistId, service: STATE_SERVICE });
      stats.ok++;
      if (DEBUG)
        console.log(`✓ ${t.slug}: ${parsed.imageUrl ? "image, " : ""}${staged} social(s) staged`);
    } else {
      stats.failed++;
      if (t.artistId)
        await recordFailure(supabase, {
          artistId: t.artistId,
          service: STATE_SERVICE,
          status: "write_failed",
          detail: "one or more writes failed",
          url: pageUrl,
        });
      // scraped_at left null → retried next run.
    }
  }
  progressDone();

  console.log(
    `Phase C result: ${stats.ok} ok — ${stats.images} portrait(s) (${stats.noImage} without), ` +
      `${stats.links} social link(s) staged, ${stats.failed} failure(s).`
  );
  if (!DRY_RUN)
    console.log("\nNext: integrate-hoer-artists.mjs (Phase D) matches these socials to bind or seed artists.");
}

main().catch((err) => {
  console.error("\nenrich-hoer-terms failed:", err?.message ?? err);
  process.exit(1);
});
