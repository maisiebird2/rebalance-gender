#!/usr/bin/env node
// ============================================================
// Artist image pruning.
//
// Three independent purge modes, exactly one required per run:
//
//   --platform=<platform>   Every image that came from one platform —
//                            for the case a platform objects to being
//                            scraped. See supabase_migration_artist_
//                            images.sql: platform + source_url are
//                            recorded on every row specifically so
//                            this is a single filtered delete.
//
//   --non-directory          Every image belonging to an artist whose
//                            directory_status is NOT 'approved' (or
//                            who is soft-deleted). Every writer
//                            (enrich-images.ts, sync-soundcloud.mjs,
//                            sync-bandcamp.mjs, store-images.mjs, the
//                            backfill migration) already restricts
//                            itself to approved artists, so rows like
//                            this should only exist for one reason: an
//                            artist who was approved (and got an
//                            image), then later demoted — rejected,
//                            not_eligible, etc. Run this after any
//                            batch of demotions, or periodically, to
//                            sweep those up.
//
//   --orphaned-links         Every image whose platform the artist no
//                            longer has a (real, non-not_found) link
//                            for. saveArtist now prunes these inline
//                            when a link is removed during an edit
//                            (see src/app/artist/[id]/edit/actions.ts,
//                            step 7b); this is the batch backfill for
//                            images orphaned by edits made before that
//                            existed. A row is orphaned when there is
//                            no artist_links row for the same
//                            (artist_id, platform) with a non-null url
//                            and not_found = false.
//
// All modes do the same three things: remove the re-hosted Storage
// object(s), delete the artist_images row(s), and clear any lingering
// harvest_failures rows for the affected image-harvesting services
// (image-enrich:<platform>, image-sync:<platform>, image-store:
// <platform>) so nothing looks pre-failed later. --platform clears
// those services globally (nothing should be harvesting that platform
// at all anymore); --non-directory and --orphaned-links clear them
// only for the specific artist+platform pairs just pruned (other
// artists' — or the same artist's other platforms' — failures are
// unrelated and left alone).
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/prune-artist-images.mjs --platform=bandcamp
//   node scripts/prune-artist-images.mjs --non-directory
//   node scripts/prune-artist-images.mjs --orphaned-links
//   DRY_RUN=1 node scripts/prune-artist-images.mjs --orphaned-links   # preview, no deletes
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  imageFailureService,
  LEGACY_IMAGE_FAILURE_SERVICE_PREFIXES,
} from "../src/lib/images/failures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const platformArg = args.find((a) => a.startsWith("--platform="));
const PLATFORM = platformArg ? platformArg.slice("--platform=".length).trim() : null;
const NON_DIRECTORY = args.includes("--non-directory");
const ORPHANED = args.includes("--orphaned-links");

const modeCount = Number(Boolean(PLATFORM)) + Number(NON_DIRECTORY) + Number(ORPHANED);
if (modeCount !== 1) {
  // None, or more than one — either way, ambiguous.
  console.error(
    "Specify exactly one of --platform=<platform>, --non-directory, or --orphaned-links.\n" +
      "Examples:\n" +
      "  node scripts/prune-artist-images.mjs --platform=bandcamp\n" +
      "  node scripts/prune-artist-images.mjs --non-directory\n" +
      "  node scripts/prune-artist-images.mjs --orphaned-links"
  );
  process.exit(1);
}

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
const SUPABASE_PAGE_SIZE = 1000;

// ------------------------------------------------------------
// The set of (artist_id, platform) pairs an artist still has a real
// link for — a non-null url that isn't marked not_found. This is the
// same "surviving link" definition saveArtist uses to decide which
// images to keep. Returned as a Set of `${artist_id}:${platform}`.
//
// Only fetched for the artists that actually have images, in small
// id-chunks: an artist has at most ~two dozen platform links, so a
// 40-id chunk stays well under PostgREST's 1000-row cap without inner
// pagination, and keeps the ?in=(...) URL short.
// ------------------------------------------------------------
async function fetchSurvivingLinkKeys(artistIds) {
  const keys = new Set();
  const CHUNK = 40;
  for (let i = 0; i < artistIds.length; i += CHUNK) {
    const chunk = artistIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("artist_links")
      .select("artist_id, platform")
      .in("artist_id", chunk)
      .eq("not_found", false)
      .not("url", "is", null);
    if (error) throw error;
    for (const l of data) keys.add(`${l.artist_id}:${l.platform}`);
  }
  return keys;
}

// ------------------------------------------------------------
// The artist_images rows to prune for whichever mode was selected
// (paginated — PostgREST caps unpaginated queries at 1000 rows).
// ------------------------------------------------------------
async function fetchRowsToPrune() {
  const allImages = [];
  let from = 0;
  while (true) {
    let query = supabase
      .from("artist_images")
      .select("artist_id, platform, storage_path, artists!inner(name, directory_status, deleted)")
      .order("artist_id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);

    if (PLATFORM) query = query.eq("platform", PLATFORM);

    const { data, error } = await query;
    if (error) throw error;

    allImages.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }

  if (PLATFORM) return allImages;

  if (NON_DIRECTORY) {
    // NOT (directory_status = 'approved' AND deleted = false). Filtered
    // client-side rather than a cross-table .or() filter — artist_images
    // is small, and this avoids relying on a PostgREST filter shape (OR
    // across an embedded resource) nothing else in this codebase exercises.
    return allImages.filter(
      (r) => r.artists?.directory_status !== "approved" || r.artists?.deleted === true
    );
  }

  // ORPHANED: keep only rows whose (artist_id, platform) has no
  // surviving link.
  const artistIds = Array.from(new Set(allImages.map((r) => r.artist_id)));
  const survivingKeys = await fetchSurvivingLinkKeys(artistIds);
  return allImages.filter((r) => !survivingKeys.has(`${r.artist_id}:${r.platform}`));
}

// Group a set of rows into platform → [artist_id, ...]. Used by the
// per-pair modes (--non-directory could delete by artist_id alone, but
// --orphaned-links must scope to the exact platform too, or it would
// delete an artist's surviving images).
function groupArtistIdsByPlatform(rows) {
  const byPlatform = new Map();
  for (const r of rows) {
    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
    byPlatform.get(r.platform).push(r.artist_id);
  }
  return byPlatform;
}

async function main() {
  const modeLabel = PLATFORM
    ? `platform "${PLATFORM}"`
    : NON_DIRECTORY
    ? "non-directory artists"
    : "orphaned platform links";
  console.log(DRY_RUN ? `DRY RUN — no deletes (${modeLabel})\n` : `Pruning images for ${modeLabel}\n`);

  const rows = await fetchRowsToPrune();
  console.log(`${rows.length} artist_images row(s) matched.`);
  if (rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const storagePaths = rows.map((r) => r.storage_path).filter(Boolean);
  console.log(`  ${storagePaths.length} of them have a re-hosted Storage object to remove.\n`);

  if (DRY_RUN) {
    for (const row of rows.slice(0, 20)) {
      const label = row.artists?.name ?? row.artist_id;
      const statusNote = NON_DIRECTORY
        ? ` (${row.artists?.directory_status ?? "?"}${row.artists?.deleted ? ", deleted" : ""})`
        : "";
      console.log(`  would remove: ${label} — ${row.platform}${statusNote}${row.storage_path ? ` [${row.storage_path}]` : ""}`);
    }
    if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);
    console.log("\nDry run — nothing deleted.");
    return;
  }

  // 1. Storage objects — remove() accepts a batch of paths at once.
  if (storagePaths.length > 0) {
    const { error: storageError } = await supabase.storage.from(BUCKET).remove(storagePaths);
    if (storageError) {
      console.error(`Failed to remove Storage objects: ${storageError.message}`);
      console.error("Stopping before touching the database — re-run once Storage removal succeeds.");
      process.exit(1);
    }
    console.log(`Removed ${storagePaths.length} Storage object(s).`);
  }

  // 2. artist_images rows.
  if (PLATFORM) {
    const { error: deleteError, count } = await supabase
      .from("artist_images")
      .delete({ count: "exact" })
      .eq("platform", PLATFORM);
    if (deleteError) {
      console.error(`Failed to delete artist_images rows: ${deleteError.message}`);
      process.exit(1);
    }
    console.log(`Deleted ${count ?? rows.length} artist_images row(s).`);
  } else if (NON_DIRECTORY) {
    const artistIds = Array.from(new Set(rows.map((r) => r.artist_id)));
    // Rows are already scoped to non-directory artists by the fetch
    // above; re-filtering by artist_id here (rather than re-deriving
    // the same OR condition against a live join) is simpler and safe
    // since between fetch and delete nothing else could have made
    // these artists approved again in the same run.
    const { error: deleteError, count } = await supabase
      .from("artist_images")
      .delete({ count: "exact" })
      .in("artist_id", artistIds);
    if (deleteError) {
      console.error(`Failed to delete artist_images rows: ${deleteError.message}`);
      process.exit(1);
    }
    console.log(`Deleted ${count ?? rows.length} artist_images row(s).`);
  } else {
    // ORPHANED: delete exactly the orphaned (artist_id, platform) pairs,
    // batched one delete per platform. Deleting by artist_id alone would
    // take out that artist's surviving images too.
    let total = 0;
    for (const [platform, artistIds] of groupArtistIdsByPlatform(rows)) {
      const { error: deleteError, count } = await supabase
        .from("artist_images")
        .delete({ count: "exact" })
        .eq("platform", platform)
        .in("artist_id", artistIds);
      if (deleteError) {
        console.error(`Failed to delete artist_images rows for ${platform}: ${deleteError.message}`);
        process.exit(1);
      }
      total += count ?? artistIds.length;
    }
    console.log(`Deleted ${total} artist_images row(s).`);
  }

  // 3. Lingering harvest_failures for the affected image-harvesting
  // services — scope depends on mode (see module header).
  if (PLATFORM) {
    const { error: failuresError, count: failuresCount } = await supabase
      .from("harvest_failures")
      .delete({ count: "exact" })
      .like("service", `%:${PLATFORM}`);
    if (failuresError) {
      console.error(`Failed to clear harvest_failures rows: ${failuresError.message}`);
    } else if (failuresCount) {
      console.log(`Cleared ${failuresCount} harvest_failures row(s) for this platform's image services.`);
    }
  } else if (NON_DIRECTORY) {
    const artistIds = Array.from(new Set(rows.map((r) => r.artist_id)));
    const { error: failuresError, count: failuresCount } = await supabase
      .from("harvest_failures")
      .delete({ count: "exact" })
      .in("artist_id", artistIds)
      .like("service", "image-%");
    if (failuresError) {
      console.error(`Failed to clear harvest_failures rows: ${failuresError.message}`);
    } else if (failuresCount) {
      console.log(`Cleared ${failuresCount} harvest_failures row(s) for these artists' image services.`);
    }
  } else {
    // ORPHANED: clear only the image-harvest failures for each pruned
    // (artist, platform) pair, so a re-added link retries cleanly while
    // the same artist's still-linked platforms keep any real failures.
    let cleared = 0;
    for (const [platform, artistIds] of groupArtistIdsByPlatform(rows)) {
      const services = [
        // Current unified acquisition key, plus the pre-unification ones
        // so a row written by an older checkout is still swept.
        imageFailureService(platform),
        ...LEGACY_IMAGE_FAILURE_SERVICE_PREFIXES.map((prefix) => `${prefix}${platform}`),
        // Re-hosting failures keep their own namespace — different concern.
        `image-store:${platform}`,
      ];
      const { error: failuresError, count: failuresCount } = await supabase
        .from("harvest_failures")
        .delete({ count: "exact" })
        .in("artist_id", artistIds)
        .in("service", services);
      if (failuresError) {
        console.error(`Failed to clear harvest_failures rows for ${platform}: ${failuresError.message}`);
      } else {
        cleared += failuresCount ?? 0;
      }
    }
    if (cleared) {
      console.log(`Cleared ${cleared} harvest_failures row(s) for these artist+platform image services.`);
    }
  }

  console.log(`\nDone. Images for ${modeLabel} fully removed.`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
