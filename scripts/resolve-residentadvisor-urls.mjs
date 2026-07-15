#!/usr/bin/env node
// ============================================================
// One-off backfill: Resident Advisor rebranded from
// residentadvisor.net to ra.co. The URL host changed but the artist
// path shape (/dj/<handle>) did not, so old links resolve with a plain
// host swap, e.g.
//
//   https://www.residentadvisor.net/dj/dianamay
//     ->  url:          https://ra.co/dj/dianamay
//         original_url: https://www.residentadvisor.net/dj/dianamay
//
// It cleans BOTH the live table and the staging table:
//
//   • artist_links           (live)    — column: url, backed up to original_url
//   • artist_harvested_links (staging) — column: parsed_url (no backup column)
//
// A row is rewritten only if its host is residentadvisor.net AND its path
// is an artist page (/dj/<handle> or the legacy plural /djs/<handle>).
// Other residentadvisor.net paths — /profile/, /features/, *.aspx, etc. —
// have no clean ra.co artist-page equivalent, so they are REPORTED and
// SKIPPED for manual review rather than guessed at.
//
// The rewrite swaps the host to ra.co (via the shared
// canonicalizeResidentAdvisorUrl, mirrored from src/lib/profile-links.ts),
// forces https, and drops any trailing slash to match the app's stored-URL
// convention.
//
// For artist_links it also preserves the full pre-swap URL in original_url,
// but only if original_url is currently empty — so an existing true
// original is never clobbered and re-runs are idempotent.
// artist_harvested_links has no original_url column, so parsed_url is
// simply rewritten in place (raw_url already holds the as-scraped value).
//
// Rows already on ra.co (or on any other host) are left untouched. Safe to
// re-run.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/resolve-residentadvisor-urls.mjs                  # fix every affected row in both tables
//   node scripts/resolve-residentadvisor-urls.mjs --links-only     # only artist_links (live)
//   node scripts/resolve-residentadvisor-urls.mjs --harvested-only # only artist_harvested_links (staging)
//   node scripts/resolve-residentadvisor-urls.mjs --limit=20       # cap affected rows per table (for testing)
//   node scripts/resolve-residentadvisor-urls.mjs --name="Diana"   # only artists whose name contains this
//   node scripts/resolve-residentadvisor-urls.mjs --debug          # log every row's decision
//   DRY_RUN=1 node scripts/resolve-residentadvisor-urls.mjs        # log what would happen, don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeResidentAdvisorUrl } from "./lib/ra-url.mjs";

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
// A residentadvisor.net URL is resolvable only when its path is an
// artist page: /dj/<handle> (current) or the legacy plural /djs/<handle>.
// Everything else on that host (/profile/, /features/, *.aspx, bare host)
// has no clean ra.co artist-page mapping and is left for manual review.
// ------------------------------------------------------------
function resolvableRaUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "residentadvisor.net" && !host.endsWith(".residentadvisor.net")) {
    return null; // not an old RA URL
  }
  if (!/^\/djs?\/[^/]+/i.test(parsed.pathname)) {
    return null; // RA host but not an artist page
  }
  // Host swap to ra.co + drop any trailing slash to match stored convention.
  return canonicalizeResidentAdvisorUrl(rawUrl).replace(/\/+$/, "");
}

// ------------------------------------------------------------
// artist_links (live). Rewrites url to the ra.co form, preserving the
// full pre-swap URL in original_url when that column is empty.
// ------------------------------------------------------------
async function processLinks() {
  console.log("── artist_links (live) ──");

  const rows = await fetchAll(
    "artist_links",
    NAME_FILTER
      ? "id, artist_id, platform, url, original_url, artists!inner(name)"
      : "id, artist_id, platform, url, original_url",
    (q) => {
      // Match on host substring so we catch old RA links no matter which
      // platform they were classified under.
      let query = q.ilike("url", "%residentadvisor.net%");
      if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
      return query;
    }
  );

  const updates = []; // { id, fields }
  let skippedNonArtist = 0;

  for (const row of rows) {
    if (!row.url) continue;

    const resolved = resolvableRaUrl(row.url);
    if (!resolved) {
      skippedNonArtist++;
      if (DEBUG) console.log(`  row #${row.id}: RA host but not an artist page, skipped: ${row.url}`);
      continue;
    }

    if (resolved === row.url) continue; // already canonical (shouldn't happen for .net host)

    const fields = { url: resolved };
    if ((row.original_url ?? null) === null) {
      fields.original_url = row.url;
    }

    updates.push({ id: row.id, fields });

    if (DEBUG) {
      console.log(
        `  row #${row.id} (${row.artist_id}): ${row.url} -> ${resolved}` +
          ("original_url" in fields ? `  [original_url <- ${fields.original_url}]` : "")
      );
    }

    if (LIMIT && updates.length >= LIMIT) break;
  }

  console.log(`  RA (.net) rows scanned:        ${rows.length}`);
  console.log(`  Non-artist path (left as-is):  ${skippedNonArtist}`);
  console.log(`  Rows to rewrite to ra.co:      ${updates.length}`);

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
// artist_harvested_links (staging). Rewrites parsed_url in place. There
// is no original_url column here — the as-scraped value is in raw_url.
// ------------------------------------------------------------
async function processHarvested() {
  console.log("── artist_harvested_links (staging) ──");

  const rows = await fetchAll(
    "artist_harvested_links",
    NAME_FILTER
      ? "id, artist_id, parsed_platform, parsed_url, artists!inner(name)"
      : "id, artist_id, parsed_platform, parsed_url",
    (q) => {
      let query = q.ilike("parsed_url", "%residentadvisor.net%");
      if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
      return query;
    }
  );

  const updates = []; // { id, parsed_url }
  let skippedNonArtist = 0;

  for (const row of rows) {
    if (!row.parsed_url) continue;

    const resolved = resolvableRaUrl(row.parsed_url);
    if (!resolved) {
      skippedNonArtist++;
      if (DEBUG) console.log(`  row #${row.id}: RA host but not an artist page, skipped: ${row.parsed_url}`);
      continue;
    }
    if (resolved === row.parsed_url) continue;

    updates.push({ id: row.id, parsed_url: resolved });
    if (DEBUG) console.log(`  row #${row.id} (${row.artist_id}): ${row.parsed_url} -> ${resolved}`);

    if (LIMIT && updates.length >= LIMIT) break;
  }

  console.log(`  RA (.net) rows scanned:        ${rows.length}`);
  console.log(`  Non-artist path (left as-is):  ${skippedNonArtist}`);
  console.log(`  Rows to rewrite to ra.co:      ${updates.length}`);

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
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Resolving old Resident Advisor URLs\n");

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
  console.error("\nBackfill failed:", err?.message ?? err);
  process.exit(1);
});
