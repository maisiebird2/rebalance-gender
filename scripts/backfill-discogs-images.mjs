#!/usr/bin/env node
// ============================================================
// backfill-discogs-images.mjs — fill artist_images (platform='discogs')
// from already-cached Discogs payloads, with ZERO new API calls.
//
// sync-discogs.mjs parks the full GET /artists/{id} response in
// api_response_cache (namespace 'discogs-artist', cache_key = numeric
// Discogs id). That payload contains the `images` array, so every artist
// synced before the image write existed already has everything needed to
// produce an image sitting in the cache. This walks those cached rows,
// maps each Discogs id back to our (approved) artist via their Discogs
// link, and runs the exact same write path the live sync now uses —
// scripts/lib/discogs-images.mjs — so the two can never diverge.
//
// It never calls the Discogs API. An artist with no cached payload is
// simply not covered here; a normal `node scripts/sync-discogs.mjs` run
// fetches and caches them (and writes their image inline).
//
// State: none of its own. Completion is an artist_images row existing;
// re-running is idempotent (upsert). By default it skips artists that
// already have a discogs image row — pass --force to re-write them.
//
// Usage (from the rebalance-gender/ folder):
//   node scripts/backfill-discogs-images.mjs            # all approved artists with a cached payload
//   node scripts/backfill-discogs-images.mjs --limit=50 # first 50 (testing)
//   node scripts/backfill-discogs-images.mjs --name="Ada"
//   node scripts/backfill-discogs-images.mjs --force    # re-write even if an image row exists
//   DRY_RUN=1 node scripts/backfill-discogs-images.mjs  # log only, no writes
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// (No DISCOGS_TOKEN — this path makes no API calls.)
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDiscogsImage } from "./lib/discogs-images.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

// ------------------------------------------------------------
// Load .env.local (same minimal loader as the other scripts).
// ------------------------------------------------------------
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

const PAGE_SIZE = 1000;

async function fetchAll(table, select, applyFilters = (q) => q) {
  const allRows = [];
  let from = 0;
  while (true) {
    let query = supabase.from(table).select(select).order("cache_key", { ascending: true });
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

// Matches discogs.com/artist/127045, /artist/127045-Aleja-Sanchez, and
// localized /de/artist/... paths. Same regex as sync-discogs.mjs.
function discogsArtistIdFromUrl(rawUrl) {
  const m = String(rawUrl).match(/discogs\.com\/(?:[a-z]{2}\/)?artist\/(\d+)/i);
  return m ? m[1] : null;
}

async function main() {
  console.log(
    DRY_RUN
      ? "Backfilling Discogs images from cache (DRY RUN — no writes)\n"
      : "Backfilling Discogs images from cache (no API calls)\n"
  );

  // Discogs numeric id -> our artist, from every artist's discogs link
  // (first link per id wins, mirroring sync-discogs's discogsIdToArtist).
  const idToArtist = new Map();
  {
    let from = 0;
    while (true) {
      let query = supabase
        .from("artist_links")
        .select("artist_id, url, artists!inner(id, name, directory_status)")
        .eq("platform", "discogs")
        .order("artist_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
      const { data, error } = await query;
      if (error) throw error;
      for (const row of data ?? []) {
        const id = discogsArtistIdFromUrl(row.url);
        if (!id || idToArtist.has(id)) continue;
        idToArtist.set(id, {
          artistId: row.artist_id,
          name: row.artists?.name ?? row.artist_id,
          isApproved: row.artists?.directory_status === "approved",
          url: row.url,
        });
      }
      if ((data?.length ?? 0) < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  // Artists that already have a discogs image row — skipped unless --force.
  const alreadyImaged = new Set();
  if (!FORCE) {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("artist_images")
        .select("artist_id")
        .eq("platform", "discogs")
        .order("artist_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      for (const r of data ?? []) alreadyImaged.add(r.artist_id);
      if ((data?.length ?? 0) < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  // Cached Discogs payloads, projecting just the images array server-side
  // so we don't drag the full blob over the wire.
  const cacheRows = await fetchAll("api_response_cache", "cache_key, images:payload->images", (q) =>
    q.eq("namespace", "discogs-artist")
  );

  console.log(
    `${cacheRows.length} cached Discogs payload(s); ${idToArtist.size} artist(s) have a Discogs link` +
      (NAME_FILTER ? ` matching "${NAME_FILTER}"` : "") +
      (FORCE ? "; --force (re-writing existing image rows)." : ".") +
      "\n"
  );

  const stats = { stored: 0, no_image: 0, not_approved: 0, failed: 0, skipped_existing: 0, no_artist: 0 };
  let processed = 0;

  for (const row of cacheRows) {
    const info = idToArtist.get(String(row.cache_key));
    if (!info) {
      stats.no_artist++; // cached payload for a Discogs id no current link points at
      continue;
    }
    if (!info.isApproved) {
      stats.not_approved++;
      continue;
    }
    if (!FORCE && alreadyImaged.has(info.artistId)) {
      stats.skipped_existing++;
      continue;
    }
    if (LIMIT != null && processed >= LIMIT) break;
    processed++;

    const status = await writeDiscogsImage({
      supabase,
      artistId: info.artistId,
      discogsUrl: info.url,
      images: row.images,
      isApproved: true,
      dryRun: DRY_RUN,
    });
    stats[status] = (stats[status] ?? 0) + 1;

    if (status === "stored") console.log(`✓ ${info.name}: image ${DRY_RUN ? "would be stored" : "stored"}`);
    else if (status === "no_image") console.log(`· ${info.name}: no image in cached payload`);
    else if (status === "failed") console.log(`✗ ${info.name}: write failed`);
  }

  console.log(
    `\nDone. ${stats.stored} image(s) ${DRY_RUN ? "would be " : ""}stored, ${stats.no_image} with no image, ` +
      `${stats.failed} write failure(s); ` +
      `${stats.skipped_existing} already had an image, ${stats.not_approved} not directory artists, ` +
      `${stats.no_artist} cached id(s) with no matching link.`
  );
}

main().catch((err) => {
  console.error("\nBackfill failed:", err?.message ?? err);
  process.exit(1);
});
