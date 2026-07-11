#!/usr/bin/env node
// ============================================================
// Read-only dry-run count for supabase_migration_strip_www_bandcamp_urls.sql.
//
// Reports how many rows the migration WOULD rewrite, using the exact
// same match as the SQL:
//
//   http(s)://www.<sub>.bandcamp.com...   ->   http(s)://<sub>.bandcamp.com...
//
// in:
//   • artist_links.url            where platform = 'bandcamp'        (live)
//   • artist_harvested_links.parsed_url
//                                 where parsed_platform = 'bandcamp' (staging)
//
// The bare apex www.bandcamp.com (no artist subdomain) is NOT matched,
// same as the migration. This never writes anything.
//
// Usage (from the rebalance-gender/ folder):
//   node scripts/count-www-bandcamp-urls.mjs           # counts per table
//   node scripts/count-www-bandcamp-urls.mjs --debug   # + list each before -> after
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG = process.argv.slice(2).includes("--debug");

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// Same pattern the migration uses (leading www. + a real subdomain).
const WWW_BANDCAMP = /^(https?:\/\/)www\.([a-z0-9-]+\.bandcamp\.com)/i;
const strip = (u) => u.replace(WWW_BANDCAMP, "$1$2");

// PostgREST caps unpaginated reads at 1000 rows; page until short.
const PAGE_SIZE = 1000;
async function fetchAll(table, select, applyFilters = (q) => q) {
  const rows = [];
  let from = 0;
  while (true) {
    let query = supabase.from(table).select(select).order("id", { ascending: true });
    query = applyFilters(query).range(from, from + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function countTable(label, table, col, platformCol, platformVal) {
  const rows = await fetchAll(table, `id, ${col}`, (q) => q.eq(platformCol, platformVal));
  const affected = rows.filter((r) => r[col] && WWW_BANDCAMP.test(r[col]));
  console.log(`── ${label} ──`);
  console.log(`  ${platformVal} rows scanned:      ${rows.length}`);
  console.log(`  rows with leading www.:  ${affected.length}`);
  if (DEBUG) {
    for (const r of affected) console.log(`    #${r.id}: ${r[col]}  ->  ${strip(r[col])}`);
  }
  return affected.length;
}

async function main() {
  console.log("DRY RUN — counting rows the www-strip migration would rewrite (no writes)\n");
  const a = await countTable("artist_links (live)", "artist_links", "url", "platform", "bandcamp");
  console.log("");
  const b = await countTable(
    "artist_harvested_links (staging)",
    "artist_harvested_links",
    "parsed_url",
    "parsed_platform",
    "bandcamp"
  );
  console.log(`\nTotal rows that would be rewritten: ${a + b}`);
  if (!DEBUG && a + b > 0) console.log("Re-run with --debug to see each before -> after.");
}

main().catch((err) => {
  console.error("\nDry-run count failed:", err?.message ?? err);
  process.exit(1);
});
