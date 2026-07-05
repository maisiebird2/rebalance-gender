#!/usr/bin/env node
// ============================================================
// One-off cleanup: some Bandcamp links point at a specific album,
// track, releases page, or follow page rather than the artist/label's
// core page. We only want the core profile URL — e.g.
//
//   https://erikagluck.bandcamp.com/album/detractor-in-the-maclura-pomifera
//     ->  url:          https://erikagluck.bandcamp.com
//         original_url: https://erikagluck.bandcamp.com/album/detractor-in-the-maclura-pomifera
//
// It cleans BOTH the live table and the staging table:
//
//   • artist_links        (live)     — column: url, backed up to original_url
//   • artist_harvested_links (staging) — column: parsed_url (no backup column)
//
// In either table, a value is rewritten only if it contains one of the
// "too deep" markers:
//        bandcamp.com/album/
//        bandcamp.com/track/
//        bandcamp.com/releases
//        bandcamp.com/follow_me
// The rewrite drops the path/query/hash, forces https, and lower-cases
// the host, leaving "https://<sub>.bandcamp.com" (no trailing slash, to
// match the app's stored-URL convention in lib/profile-links.ts).
//
// For artist_links it also preserves the full pre-strip URL in
// original_url, but only if original_url is currently empty — so an
// existing true original is never clobbered and re-runs are idempotent.
// artist_harvested_links has no original_url column, so parsed_url is
// simply rewritten in place (the raw_url column already holds the
// as-scraped value there).
//
// Rows already at a core Bandcamp page (or with no marker) are left
// untouched. Safe to re-run.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/clean-bandcamp-urls.mjs                  # fix every affected row in both tables
//   node scripts/clean-bandcamp-urls.mjs --links-only     # only artist_links (live)
//   node scripts/clean-bandcamp-urls.mjs --harvested-only # only artist_harvested_links (staging)
//   node scripts/clean-bandcamp-urls.mjs --limit=20       # cap affected rows per table (for testing)
//   node scripts/clean-bandcamp-urls.mjs --name="Erika"   # only artists whose name contains this
//   node scripts/clean-bandcamp-urls.mjs --debug          # log every row's decision
//   DRY_RUN=1 node scripts/clean-bandcamp-urls.mjs        # log what would happen, don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const LINKS_ONLY = args.includes("--links-only");
const HARVESTED_ONLY = args.includes("--harvested-only");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

const DO_LINKS = !HARVESTED_ONLY;
const DO_HARVESTED = !LINKS_ONLY;

// ------------------------------------------------------------
// Load .env.local
// ------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// ------------------------------------------------------------
// Supabase/PostgREST caps unpaginated queries at 1000 rows. Fetch
// in pages until a page comes back short.
// ------------------------------------------------------------
const PAGE_SIZE = 1000;

async function fetchAll(table, select, applyFilters = (q) => q) {
  const allRows = [];
  let from = 0;

  while (true) {
    let query = supabase.from(table).select(select).order("id", { ascending: true });
    query = applyFilters(query);
    query = query.range(from, from + PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw error;

    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return allRows;
}

// ------------------------------------------------------------
// The "too deep" path markers. A URL is stripped to its core only
// if it contains one of these (case-insensitive on the host, which
// URL parsing lower-cases anyway; the markers are all lowercase
// paths). We match on the raw string rather than the parsed path so
// that the exact substrings the task listed are what trigger a
// rewrite.
// ------------------------------------------------------------
const DEEP_MARKERS = [
  "bandcamp.com/album/",
  "bandcamp.com/track/",
  "bandcamp.com/releases",
  "bandcamp.com/follow_me",
];

function hasDeepMarker(rawUrl) {
  const lower = rawUrl.toLowerCase();
  return DEEP_MARKERS.some((m) => lower.includes(m));
}

// ------------------------------------------------------------
// Reduce a Bandcamp URL to its core artist/label page:
//   https://<host>   (scheme forced https, host lower-cased,
//   path/query/hash dropped, no trailing slash). Returns null if the
//   URL can't be parsed or isn't on a bandcamp.com host.
// ------------------------------------------------------------
function coreBandcampUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "bandcamp.com" && !host.endsWith(".bandcamp.com")) return null;
  return `https://${host}`;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
// ------------------------------------------------------------
// artist_links (live). platform = 'bandcamp'. Rewrites url to core,
// preserving the full URL in original_url when that column is empty.
// ------------------------------------------------------------
async function processLinks() {
  console.log("── artist_links (live) ──");

  const rows = await fetchAll(
    "artist_links",
    NAME_FILTER
      ? "id, artist_id, platform, url, original_url, artists!inner(name)"
      : "id, artist_id, platform, url, original_url",
    (q) => {
      let query = q.eq("platform", "bandcamp");
      if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
      return query;
    }
  );

  const updates = []; // { id, fields }
  let skippedNoMarker = 0;
  let skippedUnparseable = 0;

  for (const row of rows) {
    if (!row.url) continue;

    if (!hasDeepMarker(row.url)) {
      skippedNoMarker++;
      continue;
    }

    const core = coreBandcampUrl(row.url);
    if (!core) {
      // Contains a marker but isn't a parseable bandcamp host — leave
      // it for manual review rather than guessing.
      skippedUnparseable++;
      if (DEBUG) console.log(`  row #${row.id}: marker present but unparseable, skipped: ${row.url}`);
      continue;
    }

    const fields = { url: core };
    // Preserve the full URL only if original_url isn't already holding
    // a true original — never clobber it; keeps re-runs idempotent.
    if ((row.original_url ?? null) === null) {
      fields.original_url = row.url;
    }

    updates.push({ id: row.id, fields });

    if (DEBUG) {
      console.log(
        `  row #${row.id} (${row.artist_id}): ${row.url} -> ${core}` +
          ("original_url" in fields ? `  [original_url <- ${fields.original_url}]` : "")
      );
    }

    if (LIMIT && updates.length >= LIMIT) break;
  }

  console.log(`  Bandcamp rows scanned:       ${rows.length}`);
  console.log(`  No deep marker (left as-is): ${skippedNoMarker}`);
  console.log(`  Marker but unparseable:      ${skippedUnparseable}`);
  console.log(`  Rows to rewrite to core:     ${updates.length}`);

  if (DRY_RUN) return;

  let failures = 0;
  for (const { id, fields } of updates) {
    const { error } = await supabase.from("artist_links").update(fields).eq("id", id);
    if (error) {
      failures++;
      console.error(`  Failed to update artist_links #${id}: ${error.message}`);
    }
  }
  console.log(`  artist_links updated: ${updates.length - failures}/${updates.length}`);
}

// ------------------------------------------------------------
// artist_harvested_links (staging). parsed_platform = 'bandcamp'.
// Rewrites parsed_url to core in place. There is no original_url
// column here — the as-scraped value is already kept in raw_url.
// ------------------------------------------------------------
async function processHarvested() {
  console.log("── artist_harvested_links (staging) ──");

  const rows = await fetchAll(
    "artist_harvested_links",
    NAME_FILTER
      ? "id, artist_id, parsed_platform, parsed_url, artists!inner(name)"
      : "id, artist_id, parsed_platform, parsed_url",
    (q) => {
      let query = q.eq("parsed_platform", "bandcamp");
      if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
      return query;
    }
  );

  const updates = []; // { id, parsed_url }
  let skippedNoMarker = 0;
  let skippedUnparseable = 0;

  for (const row of rows) {
    if (!row.parsed_url) continue;

    if (!hasDeepMarker(row.parsed_url)) {
      skippedNoMarker++;
      continue;
    }

    const core = coreBandcampUrl(row.parsed_url);
    if (!core) {
      skippedUnparseable++;
      if (DEBUG) console.log(`  row #${row.id}: marker present but unparseable, skipped: ${row.parsed_url}`);
      continue;
    }

    updates.push({ id: row.id, parsed_url: core, before: row.parsed_url });
    if (DEBUG) console.log(`  row #${row.id} (${row.artist_id}): ${row.parsed_url} -> ${core}`);

    if (LIMIT && updates.length >= LIMIT) break;
  }

  console.log(`  Bandcamp rows scanned:       ${rows.length}`);
  console.log(`  No deep marker (left as-is): ${skippedNoMarker}`);
  console.log(`  Marker but unparseable:      ${skippedUnparseable}`);
  console.log(`  Rows to rewrite to core:     ${updates.length}`);

  if (DRY_RUN) return;

  let failures = 0;
  for (const { id, parsed_url } of updates) {
    const { error } = await supabase
      .from("artist_harvested_links")
      .update({ parsed_url })
      .eq("id", id);
    if (error) {
      failures++;
      console.error(`  Failed to update artist_harvested_links #${id}: ${error.message}`);
    }
  }
  console.log(`  artist_harvested_links updated: ${updates.length - failures}/${updates.length}`);
}

async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Cleaning Bandcamp URLs\n");

  if (DO_LINKS) await processLinks();
  if (DO_LINKS && DO_HARVESTED) console.log("");
  if (DO_HARVESTED) await processHarvested();

  if (DRY_RUN) {
    console.log("\nDRY RUN — no changes written.");
    if (!DEBUG) console.log("Re-run with --debug to see each rewrite.");
  } else {
    console.log("\nDone.");
  }
}

main().catch((err) => {
  console.error("\nCleanup failed:", err?.message ?? err);
  process.exit(1);
});
