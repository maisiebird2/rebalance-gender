#!/usr/bin/env tsx
// ============================================================
// Profile picture enrichment (bulk CLI).
//
// Thin driver over enrichArtistImages() in src/lib/enrich-images.ts —
// see that file for the actual per-artist logic (which platforms get
// tried, the directory-only guard, the skip-set, and why
// soundcloud/bandcamp are off-limits here since they have their own
// dedicated harvesters). This script just walks every directory
// artist and calls it — same "single per-artist unit + thin CLI
// driver" shape as sync-soundcloud.mjs.
//
// For each artist with directory_status = 'approved', tries every
// platform link that doesn't already have a stored image (or a
// confirmed no-image result), fetches the og:image meta tag, and
// stores a row per platform that succeeds in artist_images. An artist
// can end up with images from several platforms at once.
//
// Usage (from the rebalance-gender/ folder):
//
//   npx tsx scripts/enrich-images.ts                    # all approved artists, every uncovered platform
//   npx tsx scripts/enrich-images.ts --limit=20         # only the first 20 (for testing)
//   npx tsx scripts/enrich-images.ts --force            # re-check platforms that already have a stored image
//                                                        # or a confirmed no-image result (soundcloud/bandcamp
//                                                        # excepted — never touched by this script)
//   npx tsx scripts/enrich-images.ts --platforms=resident_advisor,discogs
//                                                        # only try these platforms
//   DRY_RUN=1 npx tsx scripts/enrich-images.ts          # fetch + log, don't write to the DB
//
// No cache file — state lives in the DB. A platform is skipped once
// artist_images has a row for it, or once harvest_failures has a
// confirmed 'no_og_image' row for it (service = "image-enrich:
// <platform>"). The skip is keyed to the exact link: both records store
// the profile URL they came from, so a link edited/corrected to a
// different URL is treated as never-tried and re-fetched automatically,
// force or not. If a link changes to a page with no image, the stale
// image previously stored for that platform is deleted. See
// src/lib/enrich-images.ts for the full skip-set rules.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichArtistImages, DEDICATED_HARVEST_PLATFORMS } from "../src/lib/enrich-images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const platformsArg = args.find((a) => a.startsWith("--platforms="));
const ALLOWED_PLATFORMS: string[] | undefined = platformsArg
  ? platformsArg.split("=")[1].split(",").map((p) => p.trim())
  : undefined;

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
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running image enrichment\n");
  if (FORCE) {
    console.log(
      `--force: re-checking platforms that already have a stored image or a confirmed no-image result ` +
        `(except ${[...DEDICATED_HARVEST_PLATFORMS].join(", ")}, never touched by this script)\n`
    );
  }
  if (ALLOWED_PLATFORMS) {
    console.log(`Restricted to platforms: ${ALLOWED_PLATFORMS.join(", ")}\n`);
  }

  let query = supabase
    .from("artists")
    .select("id, name")
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .order("name");

  if (LIMIT) query = query.limit(LIMIT);

  const { data: artists, error } = await query;
  if (error) throw error;

  console.log(`${artists.length} approved artist(s) to check.\n`);

  let storedCount = 0;
  let removedCount = 0;
  let attemptedCount = 0;
  let noActivity = 0;
  let fullyCovered = 0;
  const bySource: Record<string, number> = {};

  for (const artist of artists) {
    const result = await enrichArtistImages(artist.id, supabase, {
      force: FORCE,
      dryRun: DRY_RUN,
      allowedPlatforms: ALLOWED_PLATFORMS,
    });

    attemptedCount += result.attempted.length;
    removedCount += result.removed.length;

    if (result.stored.length > 0) {
      storedCount += result.stored.length;
      for (const platform of result.stored) bySource[platform] = (bySource[platform] ?? 0) + 1;
      console.log(`✓ ${artist.name}: ${result.stored.join(", ")}`);
    } else if (result.attempted.length > 0) {
      console.log(`✗ ${artist.name}: no image found (tried ${result.attempted.join(", ")})`);
    } else if (result.skippedExisting.length + result.skippedProtected.length > 0) {
      // Every candidate platform already has an image, or a confirmed
      // no-image result, or is soundcloud/bandcamp — nothing to do.
      fullyCovered++;
    } else {
      // No usable links at all.
      noActivity++;
    }
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  images stored:   ${storedCount}`);
  for (const [platform, count] of Object.entries(bySource)) {
    console.log(`    via ${platform}: ${count}`);
  }
  console.log(`  stale images removed (link changed to a page with no image): ${removedCount}`);
  console.log(`  platform attempts with no image found: ${attemptedCount - storedCount}`);
  console.log(`  artists already fully covered: ${fullyCovered}`);
  console.log(`  artists with no usable links: ${noActivity}`);
}

main().catch((err) => {
  console.error("\nEnrichment failed:", err?.message ?? err);
  process.exit(1);
});
