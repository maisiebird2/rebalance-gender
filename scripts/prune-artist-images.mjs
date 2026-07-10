#!/usr/bin/env node
// ============================================================
// Artist image pruning.
//
// Two independent purge modes, exactly one required per run:
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
// Both modes do the same three things: remove the re-hosted Storage
// object(s), delete the artist_images row(s), and clear any lingering
// harvest_failures rows for the affected image-harvesting services
// (image-enrich:<platform>, image-sync:<platform>, image-store:
// <platform>) so nothing looks pre-failed later. --platform clears
// those services globally (nothing should be harvesting that platform
// at all anymore); --non-directory clears them only for the specific
// artists just pruned (other artists' failures for the same platform
// are unrelated and left alone).
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/prune-artist-images.mjs --platform=bandcamp
//   node scripts/prune-artist-images.mjs --non-directory
//   DRY_RUN=1 node scripts/prune-artist-images.mjs --non-directory   # preview, no deletes
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
const platformArg = args.find((a) => a.startsWith("--platform="));
const PLATFORM = platformArg ? platformArg.slice("--platform=".length).trim() : null;
const NON_DIRECTORY = args.includes("--non-directory");

if (Boolean(PLATFORM) === NON_DIRECTORY) {
  // Both false, or both true — either way, ambiguous.
  console.error(
    "Specify exactly one of --platform=<platform> or --non-directory.\n" +
      "Examples:\n" +
      "  node scripts/prune-artist-images.mjs --platform=bandcamp\n" +
      "  node scripts/prune-artist-images.mjs --non-directory"
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
// Every artist_images row matching whichever mode was selected
// (paginated — PostgREST caps unpaginated queries at 1000 rows).
// ------------------------------------------------------------
async function fetchRowsToPrune() {
  const allRows = [];
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

    // Non-directory: NOT (directory_status = 'approved' AND deleted =
    // false). Filtered client-side rather than a cross-table .or()
    // filter — artist_images is small, and this avoids relying on a
    // PostgREST filter shape (OR across an embedded resource) nothing
    // else in this codebase exercises.
    const page = PLATFORM
      ? data
      : data.filter((r) => r.artists?.directory_status !== "approved" || r.artists?.deleted === true);

    allRows.push(...page);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return allRows;
}

async function main() {
  const modeLabel = PLATFORM ? `platform "${PLATFORM}"` : "non-directory artists";
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
      const statusNote = PLATFORM ? "" : ` (${row.artists?.directory_status ?? "?"}${row.artists?.deleted ? ", deleted" : ""})`;
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
  let deleteQuery = supabase.from("artist_images").delete({ count: "exact" });
  if (PLATFORM) {
    deleteQuery = deleteQuery.eq("platform", PLATFORM);
  } else {
    const artistIds = Array.from(new Set(rows.map((r) => r.artist_id)));
    deleteQuery = deleteQuery.in("artist_id", artistIds);
    // Rows are already scoped to non-directory artists by the fetch
    // above; re-filtering by artist_id here (rather than re-deriving
    // the same OR condition against a live join) is simpler and safe
    // since between fetch and delete nothing else could have made
    // these artists approved again in the same run.
  }
  const { error: deleteError, count } = await deleteQuery;
  if (deleteError) {
    console.error(`Failed to delete artist_images rows: ${deleteError.message}`);
    process.exit(1);
  }
  console.log(`Deleted ${count ?? rows.length} artist_images row(s).`);

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
  } else {
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
  }

  console.log(`\nDone. Images for ${modeLabel} fully removed.`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
