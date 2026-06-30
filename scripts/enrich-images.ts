#!/usr/bin/env tsx
// ============================================================
// Profile picture enrichment.
//
// For each artist that doesn't yet have a profile_image_url,
// looks at their linked profiles (SoundCloud, Bandcamp, Resident
// Advisor, Instagram, etc.) in priority order, fetches the page,
// and pulls the og:image meta tag as a best-effort profile photo.
// No API keys required.
//
// Usage (from the wem-directory/ folder):
//
//   npm run enrich-images                       # run on all approved directory artists missing an image
//   npm run enrich-images -- --limit=20         # only process the first 20 (for testing)
//   npm run enrich-images -- --force            # re-fetch even artists that already have an image, bypass URL cache
//   npm run enrich-images -- --platforms=soundcloud,bandcamp
//                                               # only try these platforms
//
// Only artists with directory_status = 'approved' are processed.
//   DRY_RUN=1 npm run enrich-images            # fetch + log, but don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
//
// URL fetch results are cached in image-fetch-cache.json alongside this
// script. Any URL that has already been tried (successfully or not) is
// skipped on subsequent runs. Use --force to bypass the cache entirely.
//
// This makes one HTTP request per (artist, link) pair tried, with a
// short delay between artists to be polite to the source sites. For
// ~1450 artists a full run can take a while — start with --limit to
// sanity-check results before running on everything.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOgImage, PLATFORM_PRIORITY } from "../src/lib/enrich-images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// URL-level cache — persisted to disk between runs.
// Structure: { [url]: { checkedAt: ISO string, result: string | null } }
// "result" is the og:image URL found, or null if nothing was found.
// A URL present in the cache (regardless of result) is not re-fetched
// unless --force is passed.
// ------------------------------------------------------------
const CACHE_PATH = path.join(__dirname, "image-fetch-cache.json");

function loadCache(): Record<string, { checkedAt: string; result: string | null }> {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    }
  } catch (err: any) {
    console.warn(`Warning: could not read cache file (${err.message}); starting fresh.`);
  }
  return {};
}

function saveCache(cache: Record<string, { checkedAt: string; result: string | null }>) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(`Warning: could not write cache file (${err.message}).`);
  }
}

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const platformsArg = args.find((a) => a.startsWith("--platforms="));
const ALLOWED_PLATFORMS: Set<string> | null = platformsArg
  ? new Set(platformsArg.split("=")[1].split(",").map((p) => p.trim()))
  : null;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running image enrichment\n");

  const cache = FORCE ? {} : loadCache();
  if (FORCE) {
    console.log("--force: bypassing URL cache\n");
  } else {
    const cachedCount = Object.keys(cache).length;
    if (cachedCount > 0) {
      console.log(`URL cache loaded: ${cachedCount} URL(s) already checked (pass --force to bypass)\n`);
    }
  }

  let query = supabase
    .from("artists")
    .select("id, name, profile_image_url, links:artist_links(platform, url)")
    .eq("directory_status", "approved")
    .order("name");

  if (!FORCE) {
    query = query.is("profile_image_url", null);
  }
  if (LIMIT) {
    query = query.limit(LIMIT);
  }

  const { data: allArtists, error } = await query;
  if (error) throw error;

  // Pre-filter: separate artists with no usable links from those we can work with.
  type ArtistRow = {
    id: string;
    name: string;
    profile_image_url: string | null;
    links: { platform: string; url: string }[];
    _candidates: string[];
    _linksByPlatform: Map<string, string>;
  };

  const artists: ArtistRow[] = [];
  let noLinkCount = 0;

  for (const artist of allArtists as any[]) {
    const linksByPlatform = new Map<string, string>(
      (artist.links ?? []).map((l: any) => [l.platform, l.url])
    );

    let candidates = PLATFORM_PRIORITY.filter((p) => linksByPlatform.has(p));
    if (ALLOWED_PLATFORMS) {
      candidates = candidates.filter((p) => ALLOWED_PLATFORMS!.has(p));
    }

    if (candidates.length === 0) {
      noLinkCount++;
    } else {
      artists.push({ ...artist, _candidates: candidates, _linksByPlatform: linksByPlatform });
    }
  }

  console.log(`Fetched ${allArtists.length} artist(s) from DB:`);
  console.log(`  ${noLinkCount} skipped upfront — no usable links`);
  console.log(`  ${artists.length} to process${FORCE ? " (force re-fetch)" : ""}${ALLOWED_PLATFORMS ? `, platforms: ${[...ALLOWED_PLATFORMS].join(", ")}` : ""}\n`);

  let found = 0;
  let notFound = 0;
  let allCached = 0;
  const bySource: Record<string, number> = {};

  for (const artist of artists) {
    const { _candidates: candidates, _linksByPlatform: linksByPlatform } = artist;

    let imageUrl: string | null = null;
    let source: string | null = null;
    let anyCandidateUncached = false;

    for (const platform of candidates) {
      const url = linksByPlatform.get(platform)!;

      // Skip URLs we've already tried.
      if (cache[url] !== undefined) {
        if (cache[url].result) {
          if (!imageUrl) {
            imageUrl = cache[url].result;
            source = platform;
          }
        }
        continue;
      }

      anyCandidateUncached = true;
      const fetched = await fetchOgImage(url);

      // Record in cache regardless of outcome.
      cache[url] = { checkedAt: new Date().toISOString(), result: fetched ?? null };
      if (!DRY_RUN) saveCache(cache);

      if (fetched) {
        imageUrl = fetched;
        source = platform;
        break;
      }
      await sleep(200);
    }

    if (!anyCandidateUncached && !imageUrl) {
      // Every candidate URL was already cached and none yielded an image.
      allCached++;
      console.log(`~ ${artist.name}: all URLs already checked, no image (cached)`);
      continue;
    }

    if (imageUrl) {
      found++;
      bySource[source!] = (bySource[source!] ?? 0) + 1;
      console.log(`✓ ${artist.name}: ${source} -> ${imageUrl}`);

      if (!DRY_RUN) {
        const { error: updateError } = await supabase
          .from("artists")
          .update({
            profile_image_url: imageUrl,
            profile_image_source: source,
            profile_image_fetched_at: new Date().toISOString(),
          })
          .eq("id", artist.id);
        if (updateError) {
          console.error(`  failed to save: ${updateError.message}`);
        }
      }
    } else {
      notFound++;
      console.log(`✗ ${artist.name}: no image found (tried ${candidates.join(", ")})`);
    }

    await sleep(300);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  found:     ${found}`);
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`    via ${src}: ${count}`);
  }
  console.log(`  not found: ${notFound}`);
  console.log(`  cached (no new attempts): ${allCached}`);
  console.log(`  skipped upfront (no links): ${noLinkCount}`);
}

main().catch((err) => {
  console.error("\nEnrichment failed:", err?.message ?? err);
  process.exit(1);
});
