#!/usr/bin/env node
// ============================================================
// One-time import: reads a JSON file listing Beatport entries
// and upserts them into artist_links.
//
// The JSON file should be at:
//   ../../beatport-links.json
// (i.e. next to the spreadsheet, in the "Women in electronic
// music" folder, not inside rebalance-gender/).
//
// Expected format — an array of objects:
//   [
//     { "name": "Aleja Sanchez", "url": "https://www.beatport.com/artist/aleja-sanchez/127045" },
//     ...
//   ]
//
// The handle is derived automatically from the URL: the part
// after "artist/" and before the last slash.
//
// You can generate this JSON from the spreadsheet using the
// Python helper script at ../../scripts/export-beatport-json.py.
//
// Artists are matched to existing rows by exact name (after
// trimming whitespace and normalizing to Unicode NFC, to handle
// encoding inconsistencies).
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/add-beatport-links.mjs            # import all Beatport links
//   DRY_RUN=1 node scripts/add-beatport-links.mjs  # log only, don't write to the DB
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
// Normalize a name for matching: trim whitespace and normalize
// Unicode to NFC, so e.g. an "u" + combining diaeresis (NFD)
// compares equal to the precomposed "ü" (NFC).
// ------------------------------------------------------------
function normalizeName(name) {
  return name.trim().normalize("NFC");
}

// ------------------------------------------------------------
// Extract the handle: the part of the URL after "artist/" and
// before the last slash.
//   https://www.beatport.com/artist/aleja-sanchez/127045
//     -> "aleja-sanchez"
// Falls back to the whole remainder if there's no trailing id.
// ------------------------------------------------------------
function handleFromBeatportUrl(url) {
  const afterArtist = url.split("artist/")[1];
  if (!afterArtist) return null;

  const withoutQuery = afterArtist.split(/[?#]/)[0];
  const trimmed = withoutQuery.replace(/\/+$/, "");

  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(0, lastSlash);
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : "Importing Beatport links\n"
  );

  const jsonPath = path.join(__dirname, "..", "..", "beatport-links.json");
  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `Could not find ${jsonPath}\n` +
        `Run the Python helper first:\n` +
        `  python3 "../../scripts/export-beatport-json.py"`
    );
  }

  const entries = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  if (!Array.isArray(entries)) throw new Error("beatport-links.json must be a JSON array");

  const rows = [];
  for (const { name, url } of entries) {
    if (!name || !url) continue;
    const handle = handleFromBeatportUrl(url);
    rows.push({ name: name.trim(), normalizedName: normalizeName(name), url: url.trim(), handle });
  }

  console.log(`Found ${rows.length} Beatport link(s) in beatport-links.json\n`);

  // Look up all artist ids by name
  const { data: artists, error: artistsError } = await supabase
    .from("artists")
    .select("id, name");
  if (artistsError) throw artistsError;

  const idByName = new Map();
  const dupeNames = new Set();
  for (const a of artists) {
    const key = normalizeName(a.name);
    if (idByName.has(key)) dupeNames.add(key);
    else idByName.set(key, a.id);
  }

  const linkRows = [];
  for (const { name, normalizedName, url, handle } of rows) {
    if (dupeNames.has(normalizedName)) {
      console.warn(`  skipping ${name}: multiple artists share this name, can't match uniquely`);
      continue;
    }
    const artistId = idByName.get(normalizedName);
    if (!artistId) {
      console.warn(`  skipping ${name}: no matching artist found in the database`);
      continue;
    }
    console.log(`✓ ${name}: ${url} (handle: ${handle})`);
    linkRows.push({ artist_id: artistId, platform: "beatport", url, handle });
  }

  console.log(`\n${linkRows.length} link(s) ready to ${DRY_RUN ? "import (dry run)" : "import"}`);

  if (!DRY_RUN && linkRows.length > 0) {
    const { error } = await supabase
      .from("artist_links")
      .upsert(linkRows, { onConflict: "artist_id,platform,url", ignoreDuplicates: true });
    if (error) throw error;
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
}

main().catch((err) => {
  console.error("\nImport failed:", err?.message ?? err);
  process.exit(1);
});
