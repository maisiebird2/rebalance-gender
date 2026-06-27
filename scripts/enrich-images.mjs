#!/usr/bin/env node
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
//   node scripts/enrich-images.mjs                  # run on all approved directory artists missing an image
//   node scripts/enrich-images.mjs --limit=20       # only process the first 20 (for testing)
//   node scripts/enrich-images.mjs --force          # re-fetch even artists that already have an image, bypass URL cache
//   node scripts/enrich-images.mjs --platforms=soundcloud,bandcamp
//                                                    # only try these platforms
//
// Only artists with directory_status = 'approved' are processed.
//   DRY_RUN=1 node scripts/enrich-images.mjs        # fetch + log, but don't write to the DB
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

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    }
  } catch (err) {
    console.warn(`Warning: could not read cache file (${err.message}); starting fresh.`);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
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
const ALLOWED_PLATFORMS = platformsArg
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

// ------------------------------------------------------------
// Platform priority: try these link types in this order.
// SoundCloud/Bandcamp/RA tend to have a real profile photo or
// artwork in og:image. Platforms deliberately excluded:
//   - Instagram: blocks unauthenticated fetches, og:image is a generic logo
//   - Facebook/TikTok: same issue
//   - Linktree: JS-rendered, og:image is the Linktree logo
//   - MusicBrainz: no profile photos, only release artwork
// ------------------------------------------------------------
const PLATFORM_PRIORITY = [
  "soundcloud",
  "bandcamp",
  "resident_advisor",
  "discogs",
  "beatport",
  "qobuz",
  "lastfm",
  "spotify",
  "wikipedia",
  "apple_music",
  "youtube",
  "other",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Fetch a page and pull its og:image (or twitter:image) meta tag.
// ------------------------------------------------------------
async function fetchOgImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; WEMDirectoryBot/1.0; +profile picture enrichment)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    if (!res.ok) return null;

    // Only read the <head> — og:image is always there, and pages can be huge.
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      while (html.length < 200_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }

    const metaRegex =
      /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i;

    const match = html.match(metaRegex);
    const imageUrl = match?.[1] || match?.[2];
    if (!imageUrl) return null;

    // Resolve relative URLs against the page URL
    return new URL(imageUrl, url).toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

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
  const artists = [];
  let noLinkCount = 0;

  for (const artist of allArtists) {
    const linksByPlatform = new Map(
      (artist.links ?? []).map((l) => [l.platform, l.url])
    );

    let candidates = PLATFORM_PRIORITY.filter((p) => linksByPlatform.has(p));
    if (ALLOWED_PLATFORMS) {
      candidates = candidates.filter((p) => ALLOWED_PLATFORMS.has(p));
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
  const bySource = {};

  for (const artist of artists) {
    const { _candidates: candidates, _linksByPlatform: linksByPlatform } = artist;

    let imageUrl = null;
    let source = null;
    let anyCandidateUncached = false;

    for (const platform of candidates) {
      const url = linksByPlatform.get(platform);

      // Skip URLs we've already tried.
      if (cache[url] !== undefined) {
        if (cache[url].result) {
          // We previously found an image from this URL — use it as the source if
          // we haven't found anything better yet (e.g. when re-running with --force
          // disabled but an earlier run succeeded).
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
      bySource[source] = (bySource[source] ?? 0) + 1;
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
