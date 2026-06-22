#!/usr/bin/env node
// ============================================================
// One-off cleanup: some artist_harvested_links rows got flagged as
// mismatched against artist_links purely because one side used
// "http://" and the other "https://" — e.g.
//   parsed_url:        http://andavolley.bandcamp.com/
//   artist_links_url:  https://andavolley.bandcamp.com
// (the trailing-slash/www-insensitive comparison integrate-harvested-links.mjs
// uses didn't yet ignore scheme — it does now, see normalizeForComparison
// in that file — but rows flagged by earlier runs still have the stale
// http parsed_url and/or a flag that no longer reflects a real conflict.)
//
// This script, per artist_harvested_links row:
//
//   1. Rewrites parsed_url from http:// to https:// wherever it's
//      currently http (no other change — same host/path/query).
//   2. If the row currently has an artist_links_url flag, re-checks
//      it against the (possibly just-fixed) parsed_url using the
//      same scheme/www/trailing-slash-insensitive comparison as
//      integrate-harvested-links.mjs. If they now match, the flag
//      is cleared (set to null).
//   3. If parsed_url was actually changed (http -> https), and that
//      artist's artist_links row for the same platform is the same
//      link (matches under the same insensitive comparison) but is
//      itself still on http, that live artist_links.url is updated
//      to the new https URL too — so the fix isn't just cosmetic in
//      the staging table while the live site keeps serving an http
//      link.
//
// All comparisons/decisions are made up front; writes only happen
// once you're past the summary (or are skipped entirely in DRY_RUN).
//
// Usage (from the wem-directory/ folder):
//
//   node scripts/fix-http-https-mismatches.mjs                  # fix every row that needs it
//   node scripts/fix-http-https-mismatches.mjs --limit=20       # only the first 20 affected rows (for testing)
//   node scripts/fix-http-https-mismatches.mjs --name="Danz"    # only artists whose name contains this
//   node scripts/fix-http-https-mismatches.mjs --debug          # log every row's decision
//   DRY_RUN=1 node scripts/fix-http-https-mismatches.mjs        # log what would happen, don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// Safe to re-run — rows that no longer need fixing are simply skipped.
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
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

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
// Same scheme/www/trailing-slash-insensitive comparison as
// integrate-harvested-links.mjs (duplicated rather than shared,
// matching this project's per-script convention).
// ------------------------------------------------------------
function normalizeForComparison(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function urlsMatch(a, b) {
  if (a === b) return true;
  return normalizeForComparison(a) === normalizeForComparison(b);
}

// ------------------------------------------------------------
// Rewrites http:// to https:// (no other change). Returns the
// original string unchanged if it isn't a parseable URL or isn't
// http in the first place.
// ------------------------------------------------------------
function httpsify(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:") return { url: rawUrl, changed: false };
    url.protocol = "https:";
    return { url: url.toString(), changed: true };
  } catch {
    return { url: rawUrl, changed: false };
  }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Fixing http/https mismatches\n");

  const [harvested, existingLinks] = await Promise.all([
    fetchAll(
      "artist_harvested_links",
      NAME_FILTER
        ? "id, artist_id, parsed_platform, parsed_url, artist_links_url, artists!inner(name)"
        : "id, artist_id, parsed_platform, parsed_url, artist_links_url",
      (q) => (NAME_FILTER ? q.ilike("artists.name", `%${NAME_FILTER}%`) : q)
    ),
    fetchAll("artist_links", "id, artist_id, platform, url"),
  ]);

  // Canonical live URL + row id per (artist_id, platform). If an
  // artist somehow has more than one existing row for the same
  // platform, the lowest-id one wins — arbitrary but deterministic,
  // matching integrate-harvested-links.mjs.
  const existingMap = new Map();
  for (const row of existingLinks) {
    const key = `${row.artist_id}|${row.platform}`;
    if (!existingMap.has(key)) existingMap.set(key, { id: row.id, url: row.url });
  }

  const harvestedUpdates = []; // { id, fields }
  const artistLinksUpdates = new Map(); // id -> url (deduped by target row)

  let parsedUrlFixedCount = 0;
  let flagsClearedCount = 0;
  let rowsConsidered = 0;

  for (const row of harvested) {
    const { url: httpsUrl, changed } = httpsify(row.parsed_url);

    let newFlag = row.artist_links_url ?? null;
    if (newFlag !== null && urlsMatch(httpsUrl, newFlag)) {
      newFlag = null;
    }
    const flagChanged = newFlag !== (row.artist_links_url ?? null);

    if (!changed && !flagChanged) continue;

    if (LIMIT && rowsConsidered >= LIMIT) break;
    rowsConsidered++;

    const fields = {};
    if (changed) {
      fields.parsed_url = httpsUrl;
      parsedUrlFixedCount++;
    }
    if (flagChanged) {
      fields.artist_links_url = newFlag;
      flagsClearedCount++;
    }
    harvestedUpdates.push({ id: row.id, fields });

    if (DEBUG) {
      console.log(
        `row #${row.id} (${row.artist_id}|${row.parsed_platform}):` +
          `${changed ? ` parsed_url -> ${httpsUrl}` : ""}` +
          `${flagChanged ? ` artist_links_url -> ${newFlag === null ? "null" : newFlag}` : ""}`
      );
    }

    if (changed && row.parsed_platform) {
      const key = `${row.artist_id}|${row.parsed_platform}`;
      const existing = existingMap.get(key);
      // Only touch artist_links if it's demonstrably the same link
      // (not just "same artist+platform") and it's itself still on
      // http — i.e. don't overwrite an unrelated or already-fine URL.
      if (
        existing &&
        existing.url.toLowerCase().startsWith("http://") &&
        urlsMatch(existing.url, row.parsed_url)
      ) {
        artistLinksUpdates.set(existing.id, httpsUrl);
        if (DEBUG) {
          console.log(`  -> also updating live artist_links #${existing.id}: ${existing.url} -> ${httpsUrl}`);
        }
      }
    }
  }

  console.log(`Rows scanned: ${harvested.length}`);
  console.log(`parsed_url rewritten http -> https: ${parsedUrlFixedCount}`);
  console.log(`artist_links_url flags cleared:      ${flagsClearedCount}`);
  console.log(`Live artist_links rows to update:    ${artistLinksUpdates.size}`);

  if (DRY_RUN) {
    console.log("\nDRY RUN — no changes written.");
    return;
  }

  let harvestedFailures = 0;
  for (const { id, fields } of harvestedUpdates) {
    const { error } = await supabase.from("artist_harvested_links").update(fields).eq("id", id);
    if (error) {
      harvestedFailures++;
      console.error(`Failed to update artist_harvested_links #${id}: ${error.message}`);
    }
  }

  let linksFailures = 0;
  for (const [id, url] of artistLinksUpdates) {
    const { error } = await supabase.from("artist_links").update({ url }).eq("id", id);
    if (error) {
      linksFailures++;
      console.error(`Failed to update artist_links #${id}: ${error.message}`);
    }
  }

  console.log(
    `\nDone. artist_harvested_links updated: ${harvestedUpdates.length - harvestedFailures}/${harvestedUpdates.length}` +
      `, artist_links updated: ${artistLinksUpdates.size - linksFailures}/${artistLinksUpdates.size}`
  );
}

main().catch((err) => {
  console.error("\nFix failed:", err?.message ?? err);
  process.exit(1);
});
