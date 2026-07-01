#!/usr/bin/env node
// ============================================================
// Profile image storage script.
//
// For each approved artist that has a SoundCloud enrichment with a
// profile_image_url, this script:
//   1. Rewrites the URL to request the 500×500 variant.
//   2. Downloads the image.
//   3. Uploads it to Supabase Storage under artist-images/{artist_id}.jpg
//   4. Writes the resulting public Storage URL back to artists.profile_image_url,
//      artists.profile_image_source = 'soundcloud', and artists.profile_image_fetched_at.
//
// Artists that already have a Supabase Storage URL (containing "/storage/v1/object/")
// are skipped unless --force is passed.
//
// Usage (from the wem-directory/ folder):
//
//   node scripts/store-images.mjs                  # all artists missing a stored image
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
          "Mozilla/5.0 (compatible; WEMDirectoryBot/1.0; +profile image storage)",
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

  // Fetch approved artists that have a SoundCloud image URL.
  // Primary source: artists.sc_image_url (the og:image URL moved here by the migration).
  // Fallback: artist_enrichment.profile_image_url for the soundcloud platform
  //           (populated by the API enrichment script).
  let query = supabase
    .from("artists")
    .select(
      `id, name, profile_image_url, sc_image_url,
       enrichment:artist_enrichment(platform, profile_image_url)`
    )
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .order("name");

  if (LIMIT) query = query.limit(LIMIT);

  const { data: allArtists, error } = await query;
  if (error) throw error;

  // Filter to artists that have a SoundCloud image from either source.
  const artists = allArtists.filter((a) => {
    const sourceUrl =
      a.sc_image_url ??
      a.enrichment?.find((e) => e.platform === "soundcloud" && e.profile_image_url)
        ?.profile_image_url;

    if (!sourceUrl) return false;

    // Skip if already stored in Supabase Storage (unless --force).
    const alreadyStored = a.profile_image_url?.includes("/storage/v1/object/");
    if (alreadyStored && !FORCE) return false;

    a._sourceImageUrl = sourceUrl;
    return true;
  });

  console.log(`${allArtists.length} approved artists fetched from DB.`);
  console.log(
    `${artists.length} to process (have SoundCloud image${FORCE ? ", force re-upload" : ", not yet stored"}).\n`
  );

  let uploaded = 0;
  let failed = 0;

  for (const artist of artists) {
    const sourceUrl = toSize500(artist._sourceImageUrl);

    process.stdout.write(`${artist.name} … `);

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
          profile_image_source: "soundcloud",
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
