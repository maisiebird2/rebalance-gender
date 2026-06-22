#!/usr/bin/env node
// ============================================================
// One-time data migration: loads the normalized spreadsheet
// (../../women, femmes, enbies of electronic music - list
// (genres normalized).csv), plus the genres and pronouns lookup
// tables, into Supabase.
//
// Usage (from the wem-directory/ folder):
//
//   npm run migrate            # run the import
//   DRY_RUN=1 npm run migrate  # parse + validate only, no writes
//
// Requires .env.local to have NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SECRET_KEY set (the secret key bypasses RLS so it can
// write 'approved' rows directly). Run supabase_schema.sql first.
//
// Safe to run only once on an empty database — re-running will
// create duplicate artists/links/locations since there's no
// upsert key on `artists`. If you need to re-run after a partial
// failure, truncate the artists table (cascades to related tables)
// first, e.g.:
//
//   truncate table artists cascade;
//
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// Load .env.local (the project doesn't otherwise load it for
// plain `node` scripts).
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
      "Fill these in in .env.local before running the migration."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// ------------------------------------------------------------
// Minimal CSV parser (handles quoted fields, embedded commas,
// embedded newlines, and "" escaped quotes — no external deps).
// ------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const normalized = text.replace(/\r\n/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];

    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length && r.some((v) => v !== ""))
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
      return obj;
    });
}

function readCSV(filename) {
  const filePath = path.join(__dirname, "..", "..", filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Could not find ${filename} at ${filePath}`);
  }
  return parseCSV(fs.readFileSync(filePath, "utf-8"));
}

// ------------------------------------------------------------
// Platform link config: CSV column -> link_platform enum value,
// plus a best-effort URL builder for each.
//
// Beatport / Qobuz / Discogs values in the spreadsheet are slugs
// or numeric IDs without enough context to build a guaranteed-
// correct profile URL. These are best-effort and may need fixing
// up later during the enrichment pass.
// ------------------------------------------------------------
const PLATFORM_COLUMNS = {
  SC: "soundcloud",
  IG: "instagram",
  RA: "resident_advisor",
  Bandcamp: "bandcamp",
  Beatport: "beatport",
  Qobuz: "qobuz",
  Discogs: "discogs",
};

function buildUrl(platform, handle) {
  switch (platform) {
    case "soundcloud":
      return `https://soundcloud.com/${handle}`;
    case "instagram":
      return `https://instagram.com/${handle}`;
    case "resident_advisor":
      return `https://ra.co/dj/${handle}`;
    case "bandcamp":
      return `https://${handle}.bandcamp.com`;
    case "beatport":
      return `https://www.beatport.com/artist/${handle}`;
    case "qobuz":
      return `https://www.qobuz.com/us-en/interpreter/${handle}/download-streaming-albums`;
    case "discogs":
      return `https://www.discogs.com/artist/${handle}`;
    default:
      return handle;
  }
}

function isMissing(value) {
  return !value || value.trim() === "" || value.trim().toLowerCase() === "n/a";
}

// ------------------------------------------------------------
// Find-or-create helpers
// ------------------------------------------------------------
async function findOrCreate(table, column, value, extra = {}) {
  const { data: existing, error: selErr } = await supabase
    .from(table)
    .select("id")
    .eq(column, value)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing.id;

  const { data: created, error: insErr } = await supabase
    .from(table)
    .insert({ [column]: value, ...extra })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return created.id;
}

async function insertInChunks(table, rows, chunkSize = 500) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (DRY_RUN) {
      inserted += chunk.length;
      continue;
    }
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
    inserted += chunk.length;
  }
  return inserted;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running migration\n");

  // Safety check: refuse to run on a non-empty artists table
  // unless dry-running, to avoid creating duplicates.
  if (!DRY_RUN) {
    const { count, error } = await supabase
      .from("artists")
      .select("id", { count: "exact", head: true });
    if (error) throw error;
    if (count && count > 0) {
      console.error(
        `The artists table already has ${count} row(s). Refusing to run to avoid ` +
          `duplicates.\nIf you want to re-run from scratch, run ` +
          `"truncate table artists cascade;" in the Supabase SQL editor first.`
      );
      process.exit(1);
    }
  }

  const genresLookup = readCSV("genres_lookup.csv");
  const pronounsLookup = readCSV("pronouns_lookup.csv");
  const artistsCsv = readCSV(
    "women, femmes, enbies of electronic music - list (genres normalized).csv"
  );

  console.log(`Loaded ${genresLookup.length} genres, ${pronounsLookup.length} pronouns, ${artistsCsv.length} artist rows\n`);

  // --- Step 1: genres lookup (slug -> genres.id, keyed by display_name) ---
  console.log("Upserting genres...");
  const genreIdBySlug = new Map();
  for (const g of genresLookup) {
    const name = g.display_name?.trim();
    const slug = g.slug?.trim();
    if (!name || !slug) continue;
    const id = DRY_RUN ? `dry:${name}` : await findOrCreate("genres", "name", name);
    genreIdBySlug.set(slug, id);
  }

  // Catch any slugs used in the artist CSV but missing from the lookup.
  const allSlugs = new Set();
  for (const row of artistsCsv) {
    for (const slug of (row.genres_normalized || "").split(";").map((s) => s.trim()).filter(Boolean)) {
      allSlugs.add(slug);
    }
  }
  for (const slug of allSlugs) {
    if (!genreIdBySlug.has(slug)) {
      console.warn(`  genre slug "${slug}" not in genres_lookup.csv — creating as-is`);
      const id = DRY_RUN ? `dry:${slug}` : await findOrCreate("genres", "name", slug);
      genreIdBySlug.set(slug, id);
    }
  }
  console.log(`  ${genreIdBySlug.size} genres ready\n`);

  // --- Step 2: pronouns lookup (value -> pronouns.id) ---
  console.log("Upserting pronouns...");
  const pronounIdByValue = new Map();
  for (const p of pronounsLookup) {
    const value = p.value?.trim().toLowerCase();
    if (!value) continue;
    const id = DRY_RUN ? `dry:${value}` : await findOrCreate("pronouns", "value", value);
    pronounIdByValue.set(value, id);
  }

  const allPronouns = new Set();
  for (const row of artistsCsv) {
    const value = row.pronouns_normalized?.trim().toLowerCase();
    if (value) allPronouns.add(value);
  }
  for (const value of allPronouns) {
    if (!pronounIdByValue.has(value)) {
      console.warn(`  pronoun "${value}" not in pronouns_lookup.csv — creating as-is`);
      const id = DRY_RUN ? `dry:${value}` : await findOrCreate("pronouns", "value", value);
      pronounIdByValue.set(value, id);
    }
  }
  console.log(`  ${pronounIdByValue.size} pronoun values ready\n`);

  // --- Step 3: artists ---
  console.log("Inserting artists...");

  function buildArtistInsert(row) {
    const name = row.name?.trim();
    if (!name) return null;

    const noteParts = [];
    if (row.notes?.trim()) noteParts.push(row.notes.trim());
    if (row.roles?.trim()) noteParts.push(`Role(s): ${row.roles.trim()}`);
    if (row.genre_uncertain?.trim().toLowerCase() === "true") {
      noteParts.push("Genre uncertain (flagged during data import)");
    }
    if (row.pronouns_flagged?.trim().toLowerCase() === "true") {
      noteParts.push("Pronouns flagged (flagged during data import)");
    }
    const otherLinks = row["other links"]?.trim();
    if (otherLinks && !/^https?:\/\//i.test(otherLinks)) {
      noteParts.push(`Other: ${otherLinks}`);
    }

    const pronounValue = row.pronouns_normalized?.trim().toLowerCase();
    const pronounId = pronounValue ? pronounIdByValue.get(pronounValue) ?? null : null;

    return {
      name,
      pronoun_id: DRY_RUN ? null : pronounId,
      labels: row["labels etc"]?.trim() || null,
      notes: noteParts.length ? noteParts.join(" | ") : null,
      directory_status: "approved",
    };
  }

  const ARTIST_BATCH = 100;
  const nameToId = new Map();
  let artistCount = 0;

  for (let i = 0; i < artistsCsv.length; i += ARTIST_BATCH) {
    const batch = artistsCsv
      .slice(i, i + ARTIST_BATCH)
      .map(buildArtistInsert)
      .filter(Boolean);
    if (batch.length === 0) continue;

    if (DRY_RUN) {
      for (const row of batch) nameToId.set(row.name, `dry:${row.name}`);
      artistCount += batch.length;
      continue;
    }

    const { data, error } = await supabase.from("artists").insert(batch).select("id, name");
    if (error) throw error;
    for (const r of data) nameToId.set(r.name, r.id);
    artistCount += data.length;
  }
  console.log(`  ${artistCount} artists inserted\n`);

  // --- Step 4: genres, locations, links (built from nameToId) ---
  console.log("Building related rows (genres, locations, links)...");

  const artistGenreRows = [];
  const artistLocationRows = [];
  const artistLinkRows = [];

  for (const row of artistsCsv) {
    const name = row.name?.trim();
    if (!name) continue;
    const artistId = nameToId.get(name);
    if (!artistId) continue;

    // Genres
    const seenGenres = new Set();
    for (const slug of (row.genres_normalized || "").split(";").map((s) => s.trim()).filter(Boolean)) {
      const genreId = genreIdBySlug.get(slug);
      if (!genreId || seenGenres.has(genreId)) continue;
      seenGenres.add(genreId);
      artistGenreRows.push({ artist_id: artistId, genre_id: genreId });
    }

    // Locations
    for (const loc of (row["based in"] || "").split(";").map((s) => s.trim()).filter(Boolean)) {
      const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
      const country = parts.length > 1 ? parts[parts.length - 1] : parts[0] || null;
      const city = parts.length > 1 ? parts.slice(0, -1).join(", ") : null;
      artistLocationRows.push({ artist_id: artistId, city, country, raw_text: loc });
    }

    // Platform links
    for (const [col, platform] of Object.entries(PLATFORM_COLUMNS)) {
      const handle = row[col]?.trim();
      if (isMissing(handle)) continue;
      artistLinkRows.push({
        artist_id: artistId,
        platform,
        handle,
        url: buildUrl(platform, handle),
      });
    }

    // "other links" — only when it's actually a URL
    const otherLinks = row["other links"]?.trim();
    if (otherLinks && /^https?:\/\//i.test(otherLinks)) {
      artistLinkRows.push({ artist_id: artistId, platform: "other", handle: null, url: otherLinks });
    }
  }

  console.log(`  ${artistGenreRows.length} artist_genres rows`);
  console.log(`  ${artistLocationRows.length} artist_locations rows`);
  console.log(`  ${artistLinkRows.length} artist_links rows\n`);

  console.log("Inserting genres links, locations, and links...");
  const genresInserted = await insertInChunks("artist_genres", artistGenreRows);
  const locationsInserted = await insertInChunks("artist_locations", artistLocationRows);
  const linksInserted = await insertInChunks("artist_links", artistLinkRows);

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  artists:        ${artistCount}`);
  console.log(`  artist_genres:  ${genresInserted}`);
  console.log(`  artist_locations: ${locationsInserted}`);
  console.log(`  artist_links:   ${linksInserted}`);
}

main().catch((err) => {
  console.error("\nMigration failed:");
  console.error("  message:", err?.message);
  console.error("  details:", err?.details);
  console.error("  hint:", err?.hint);
  console.error("  code:", err?.code);
  console.error("  full:", JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})));
  process.exit(1);
});
