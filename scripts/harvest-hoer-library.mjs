#!/usr/bin/env node
// ============================================================
// harvest-hoer-library.mjs — Phase A of the HÖR sync rework.
//
// Ingests HÖR's library of sets (WordPress posts) into the hoer_sets ledger.
// This is the spine of the new system: everything else (seed-hoer-terms,
// enrich-hoer-terms, integrate-hoer-artists) reads from this table rather
// than re-crawling HÖR. See documentation/HOER-SYNC-REWORK-PLAN.md.
//
// It replaces the roster-first sync-hoer.mjs, whose fixed ~100-request
// enumeration of all 9,954 ppma_author terms ran every round. Here the posts
// feed IS the spine: each post carries its authors inline (term id, slug,
// display/first/last name, bio), so artists are discovered from the sets they
// appear on — no roster crawl.
//
// Window (see computeCrawlStart in lib/hoer-library.mjs):
//   • --from=<ISO date>  crawl from that date forward (seed / re-cover a period)
//   • --rewind-days=<N>  incremental, but rewind N days from max(post_date)
//   • no flag            incremental: rewind the default 7 days from the ledger's
//                        newest post_date. The overlap is deliberate — it covers
//                        the boundary and gives the modified_after sweep a wide
//                        window for sets tagged/re-credited after publication.
//   • no flag, empty ledger → hard error (never a silent full-archive crawl).
//
// Two sweeps per run, unioned by post_id:
//   1. posts?after=<start>          — newly published sets
//   2. posts?modified_after=<start> — sets edited since (tags and author
//                                     credits often land after publication)
//
// Idempotency: each row's processed_at is reconciled against the ledger —
// null for new or genuinely-modified posts (Phase B must (re)consume them),
// preserved otherwise — so the deliberate re-reads never replay Phase B's
// genre/collab writes. This is the mechanism that makes the rewind safe.
//
// Usage (from the rebalance-gender/ folder):
//   npm run harvest-hoer-library                        # incremental
//   tsx scripts/harvest-hoer-library.mjs --from=2026-02-04   # seed the ledger
//   tsx scripts/harvest-hoer-library.mjs --rewind-days=30    # wider sweep
//   tsx scripts/harvest-hoer-library.mjs --limit=200         # cap posts (testing)
//   DRY_RUN=1 tsx scripts/harvest-hoer-library.mjs           # fetch + log, no writes
//   tsx scripts/harvest-hoer-library.mjs --debug             # verbose
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// (No HÖR token — its REST API is public.)
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { loadEnvLocal, createSupabase } from "./lib/hoer-db.mjs";
import { hoerJson } from "./lib/hoer-http.mjs";
import {
  DEFAULT_REWIND_DAYS,
  computeCrawlStart,
  normalizeNaive,
  postToSetRow,
  reconcileProcessedAt,
} from "./lib/hoer-library.mjs";

const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const fromArg = argValue("--from");
const rewindArg = argValue("--rewind-days");
const limitArg = argValue("--limit");
const REWIND_DAYS = rewindArg != null ? parseInt(rewindArg, 10) : DEFAULT_REWIND_DAYS;
const LIMIT = limitArg != null ? parseInt(limitArg, 10) : null;

function argValue(flag) {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

if (rewindArg != null && (!Number.isFinite(REWIND_DAYS) || REWIND_DAYS < 0)) {
  console.error(`--rewind-days must be a non-negative integer (got ${JSON.stringify(rewindArg)}).`);
  process.exit(1);
}
if (limitArg != null && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  console.error(`--limit must be a positive integer (got ${JSON.stringify(limitArg)}).`);
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

// ------------------------------------------------------------
// Compact progress: rewrite one line on a TTY, fresh lines when piped.
// ------------------------------------------------------------
const IS_TTY = Boolean(process.stdout.isTTY);
function progress(msg) {
  if (IS_TTY) process.stdout.write(`\r${msg}\x1b[K`);
  else console.log(msg);
}
function progressDone() {
  if (IS_TTY) process.stdout.write("\n");
}

const POSTS_FIELDS =
  "id,date,date_gmt,modified,modified_gmt,slug,link,title,content,excerpt,tags,ppma_author,authors";
const CHUNK = 100;

// ------------------------------------------------------------
// Read the incremental cursor: the newest post_date already in the ledger.
// Null when the table is empty (→ --from required).
// ------------------------------------------------------------
async function readMaxPostDate() {
  const { data, error } = await supabase
    .from("hoer_sets")
    .select("post_date")
    .order("post_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`couldn't read hoer_sets cursor: ${error.message}`);
  return data?.post_date ?? null;
}

// ------------------------------------------------------------
// Crawl one sweep. `param` is "after" or "modified_after". Pages ascending by
// date until a short/empty page. Collects raw posts into `byId` (deduped —
// the two sweeps overlap heavily). Returns the number of posts collected by
// THIS sweep. Honours the global LIMIT across both sweeps via byId.size.
// ------------------------------------------------------------
async function crawlSweep(param, start, byId, label) {
  let swept = 0;
  for (let page = 1; ; page++) {
    if (LIMIT && byId.size >= LIMIT) break;
    const { ok, data } = await hoerJson(
      `/wp-json/wp/v2/posts?per_page=100&page=${page}&orderby=date&order=asc` +
        `&${param}=${encodeURIComponent(start)}&_fields=${POSTS_FIELDS}`
    );
    if (!ok) {
      console.error(`\n  (${label} page ${page} failed — stopping this sweep)`);
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const post of data) {
      if (post?.id == null) continue;
      if (!byId.has(post.id)) byId.set(post.id, post);
      swept++;
      if (LIMIT && byId.size >= LIMIT) break;
    }
    progress(`  ${label}: ${swept} post(s) read (page ${page}); ${byId.size} unique so far`);
    if (data.length < 100) break;
  }
  progressDone();
  return swept;
}

// ------------------------------------------------------------
// Look up existing ledger rows for the crawled ids, so processed_at can be
// reconciled (new / modified → null; unchanged → keep). Batched .in() reads.
// Returns Map<post_id, { post_modified, processed_at }>.
// ------------------------------------------------------------
async function loadExisting(postIds) {
  const existing = new Map();
  for (let i = 0; i < postIds.length; i += 500) {
    const chunk = postIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from("hoer_sets")
      .select("post_id, post_modified, processed_at")
      .in("post_id", chunk);
    if (error) throw new Error(`couldn't read existing hoer_sets rows: ${error.message}`);
    for (const r of data ?? []) existing.set(r.post_id, r);
  }
  return existing;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(DRY_RUN ? "harvest-hoer-library — DRY RUN (no writes)\n" : "harvest-hoer-library\n");

  // 1. Window. Only consult the ledger cursor for an incremental run — a
  // --from run ignores it, and shouldn't fail if the table isn't there yet.
  const maxPostDate = fromArg != null && String(fromArg).trim() !== "" ? null : await readMaxPostDate();
  let plan;
  try {
    plan = computeCrawlStart({ fromArg, rewindDays: REWIND_DAYS, maxPostDate });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { start, mode } = plan;
  console.log(
    mode === "from"
      ? `Crawling from --from=${start}.`
      : `Incremental: ledger max post_date ${maxPostDate}, rewound ${REWIND_DAYS} day(s) → ${start}.`
  );
  if (LIMIT) console.log(`--limit=${LIMIT}: capping the crawl (cursor still reflects what was read).`);

  // 2. Two sweeps, unioned by post id.
  const byId = new Map();
  await crawlSweep("after", start, byId, "Sweep 1 (after)");
  await crawlSweep("modified_after", start, byId, "Sweep 2 (modified_after)");
  const posts = [...byId.values()];
  console.log(`Collected ${posts.length} unique set(s) across both sweeps.`);
  if (posts.length === 0) {
    console.log("Nothing to ingest.");
    return;
  }

  // 3. Shape + reconcile processed_at against the ledger.
  const rows = posts.map(postToSetRow);
  const existing = DRY_RUN ? new Map() : await loadExisting(rows.map((r) => r.post_id));
  let newCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;
  for (const row of rows) {
    const prior = existing.get(row.post_id);
    row.processed_at = reconcileProcessedAt(row, prior);
    // Label by comparing post_modified directly — NOT by whether processed_at
    // came back null. An unchanged set whose processed_at was already null
    // (Phase B hasn't consumed it yet) also reconciles to null, and must not
    // be miscounted as modified.
    if (!prior) newCount++;
    else if (normalizeNaive(prior.post_modified) !== row.post_modified) modifiedCount++;
    else unchangedCount++;
  }

  if (DRY_RUN) {
    console.log(
      `Would upsert ${rows.length} row(s). (Existing rows not read in a dry run, so new/modified ` +
        `split is not computed.)`
    );
    if (DEBUG) for (const r of rows.slice(0, 20)) console.log(`  ~ ${r.post_id} ${r.post_date} ${r.set_slug}`);
    return;
  }

  // 4. Upsert in chunks.
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("hoer_sets").upsert(chunk, { onConflict: "post_id" });
    if (error) {
      console.error(`  (upsert chunk at ${i} failed: ${error.message})`);
      continue;
    }
    written += chunk.length;
    progress(`  Writing ledger… ${written}/${rows.length}`);
  }
  progressDone();

  console.log(
    `Ingested ${written} set(s): ${newCount} new, ${modifiedCount} re-read as modified ` +
      `(processed_at reset), ${unchangedCount} unchanged.`
  );
  console.log("\nNext: seed-hoer-terms.mjs (Phase B) consumes rows where processed_at is null.");
}

main().catch((err) => {
  console.error("\nharvest-hoer-library failed:", err?.message ?? err);
  process.exit(1);
});
