#!/usr/bin/env node
// ============================================================
// Profile image storage script.
//
// Generalized (per PIPELINE.md, "Generalize store-images.mjs (5b) to
// all image sources") to re-host from ANY platform, not just
// SoundCloud. For each approved artist, picks the best available
// source image by the same priority order enrich-images.ts (5a) uses
// — PLATFORM_PRIORITY below — downloads it, uploads it to Supabase
// Storage under artist-images/{artist_id}.{ext}, and writes the
// resulting public Storage URL back to artists.profile_image_url,
// the TRUE artists.profile_image_source (not hardcoded 'soundcloud'
// — the bug this generalization fixes), and
// artists.profile_image_fetched_at.
//
// Where a source image can come from, in priority order:
//   - soundcloud: artists.sc_image_url (legacy migration column) or
//     artist_enrichment(platform='soundcloud').profile_image_url
//     (sync-soundcloud.mjs's upgraded 500x500 avatar) — whichever is
//     present; sc_image_url wins if both are.
//   - any other platform in PLATFORM_PRIORITY (bandcamp, resident_advisor,
//     …): artist_enrichment(platform=X).profile_image_url, written by
//     that platform's own sync script (e.g. sync-bandcamp.mjs), OR —
//     if no enrichment row exists for X but 5a already picked X as
//     the current best guess — artists.profile_image_url itself, when
//     artists.profile_image_source === X.
//
// The SoundCloud-CDN 500×500 resize rewrite (toSize500) is applied
// ONLY when the picked source is actually SoundCloud; every other
// source is fetched at whatever size its og:image/profile-image URL
// provides, per the PIPELINE.md plan.
//
// Bug this fixes: the old SoundCloud-only version only skipped
// artists already on a Storage URL, with no regard for WHICH source
// that Storage image came from — so an artist whose image 5a chose
// from Bandcamp (hot-linked, not yet on Storage) got silently
// overwritten by a re-hosted SoundCloud image the moment one existed,
// ignoring priority order entirely. This version re-derives the true
// best-priority source every run and only treats an artist as "done"
// when the recorded profile_image_source actually matches that
// source.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/store-images.mjs                  # all artists needing a (re)stored image
//   node scripts/store-images.mjs --limit=20       # test on first 20
//   node scripts/store-images.mjs --force          # re-download and overwrite existing
//   DRY_RUN=1 node scripts/store-images.mjs        # log only, no uploads or DB writes
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.
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
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

// ------------------------------------------------------------
// Load .env.local
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
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "artist-images";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Platform priority — must match src/lib/enrich-images.ts's exported
// PLATFORM_PRIORITY. Kept as a local copy rather than a cross-module
// import: this script runs under plain `node` (not `tsx`, which the
// TypeScript enrich-images.ts requires), same per-script-copy
// convention already used for the small domain-classification tables
// in sync-soundcloud.mjs / sync-bandcamp.mjs. If enrich-images.ts's
// list changes, update this one too.
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

// ------------------------------------------------------------
// Rewrite a SoundCloud image URL to request the 500×500 variant.
// SoundCloud encodes the size as a suffix before the extension:
//   …-large.jpg        → 100×100  (most common in og:image)
//   …-t300x300.jpg     → 300×300
//   …-t500x500.jpg     → 500×500  (what we want)
//   …-original.jpg     → original upload
// If the URL doesn't match the expected pattern we leave it as-is.
// ------------------------------------------------------------
function toSize500(url) {
  // Replace any known size suffix with t500x500.
  return url.replace(
    /-(mini|small|badge|t67x67|large|t300x300|crop|t500x500|original)(\.\w+)$/,
    "-t500x500$2"
  );
}

// ------------------------------------------------------------
// Ensure the storage bucket exists and is public.
// (Safe to call every run — Supabase returns a 409 if it already exists.)
// ------------------------------------------------------------
async function ensureBucket() {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024, // 5 MB
  });
  if (error && !error.message.includes("already exists")) {
    throw new Error(`Could not create bucket "${BUCKET}": ${error.message}`);
  }
}

// ------------------------------------------------------------
// Download an image URL and return { buffer, contentType }.
// Returns null on any failure.
// ------------------------------------------------------------
async function downloadImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +profile image storage)",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
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
  console.log(DRY_RUN ? "DRY RUN — no uploads or DB writes\n" : "Storing profile images\n");

  if (!DRY_RUN) {
    await ensureBucket();
    console.log(`Bucket "${BUCKET}" ready.\n`);
  }

  // Fetch approved artists with every possible image source: the
  // legacy SoundCloud-specific column, every platform's
  // artist_enrichment row, and the artist's current profile_image_url
  // / profile_image_source (5a's best guess, or a prior 5b run).
  let query = supabase
    .from("artists")
    .select(
      `id, name, profile_image_url, profile_image_source, sc_image_url,
       enrichment:artist_enrichment(platform, profile_image_url)`
    )
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .order("name");

  if (LIMIT) query = query.limit(LIMIT);

  const { data: allArtists, error } = await query;
  if (error) throw error;

  // For each artist, walk PLATFORM_PRIORITY and pick the first
  // platform with an available source image — same priority order 5a
  // uses, so 5b never demotes a higher-priority source in favor of a
  // lower one just because the lower one happens to be cached in
  // artist_enrichment.
  function pickBestSource(a) {
    for (const platform of PLATFORM_PRIORITY) {
      if (platform === "soundcloud") {
        const url =
          a.sc_image_url ??
          a.enrichment?.find((e) => e.platform === "soundcloud" && e.profile_image_url)
            ?.profile_image_url;
        if (url) return { platform, url };
        continue;
      }

      const enrichmentUrl = a.enrichment?.find(
        (e) => e.platform === platform && e.profile_image_url
      )?.profile_image_url;
      if (enrichmentUrl) return { platform, url: enrichmentUrl };

      // No dedicated enrichment row for this platform, but 5a already
      // chose it as the current best guess — use what it stored.
      if (a.profile_image_source === platform && a.profile_image_url) {
        return { platform, url: a.profile_image_url };
      }
    }
    return null;
  }

  // Filter to artists that have SOME source image, and where the true
  // best source isn't already correctly re-hosted on Storage.
  const artists = allArtists.filter((a) => {
    const best = pickBestSource(a);
    if (!best) return false;

    const alreadyStored = a.profile_image_url?.includes("/storage/v1/object/");
    // Only treat as "done" when the Storage image actually reflects
    // the current best-priority source — otherwise a higher-priority
    // source appeared since (or the recorded source was never set)
    // and this artist needs re-hosting from it.
    const doneForBestSource = alreadyStored && a.profile_image_source === best.platform;
    if (doneForBestSource && !FORCE) return false;

    a._source = best;
    return true;
  });

  console.log(`${allArtists.length} approved artists fetched from DB.`);
  console.log(
    `${artists.length} to process (have a source image${FORCE ? ", force re-upload" : ", not yet correctly stored"}).\n`
  );

  let uploaded = 0;
  let failed = 0;

  for (const artist of artists) {
    const { platform: sourcePlatform, url: rawSourceUrl } = artist._source;
    // The SoundCloud CDN resize rewrite only makes sense for actual
    // SoundCloud URLs — every other source is fetched at whatever
    // size its own URL provides.
    const sourceUrl = sourcePlatform === "soundcloud" ? toSize500(rawSourceUrl) : rawSourceUrl;

    process.stdout.write(`${artist.name} (${sourcePlatform}) … `);

    const downloaded = await downloadImage(sourceUrl);
    if (!downloaded) {
      console.log("✗ download failed");
      failed++;
      await sleep(300);
      continue;
    }

    const { buffer, contentType } = downloaded;
    const ext = contentType.includes("png") ? "png" : "jpg";
    const storagePath = `${artist.id}.${ext}`;
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;

    if (!DRY_RUN) {
      // upsert: overwrite if the file already exists (covers --force).
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buffer, {
          contentType,
          upsert: true,
        });

      if (uploadError) {
        console.log(`✗ upload failed: ${uploadError.message}`);
        failed++;
        await sleep(300);
        continue;
      }

      const { error: updateError } = await supabase
        .from("artists")
        .update({
          profile_image_url: publicUrl,
          profile_image_source: sourcePlatform,
          profile_image_fetched_at: new Date().toISOString(),
        })
        .eq("id", artist.id);

      if (updateError) {
        console.log(`✗ DB update failed: ${updateError.message}`);
        failed++;
        await sleep(300);
        continue;
      }
    }

    console.log(`✓ ${Math.round(buffer.length / 1024)} KB → ${publicUrl}`);
    uploaded++;
    await sleep(200);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  uploaded: ${uploaded}`);
  console.log(`  failed:   ${failed}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
