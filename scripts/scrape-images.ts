#!/usr/bin/env tsx
// ============================================================
// Profile picture enrichment (bulk CLI).
//
// Thin driver over scrapeArtistImages() in src/lib/scrape-images.ts —
// see that file for the actual per-artist logic (which platforms get
// tried, the directory-only guard, and the skip-set). This script just
// walks every directory artist and calls it — same "single per-artist
// unit + thin CLI driver" shape as sync-soundcloud.mjs.
//
// This owns image acquisition for every platform that has no harvester
// of its own. soundcloud and bandcamp belong to sync-soundcloud.mjs and
// sync-bandcamp.mjs; this script only falls back to scraping them when
// the owner recorded a transient failure. Run --list to see the split.
//
// For each artist with directory_status = 'approved', tries every
// platform link that doesn't already have a stored image (or a
// confirmed no-image result), fetches the og:image meta tag, and
// stores a row per platform that succeeds in artist_images. An artist
// can end up with images from several platforms at once.
//
// Usage (from the rebalance-gender/ folder):
//
//   npx tsx scripts/scrape-images.ts                    # all approved artists, every uncovered platform
//   npx tsx scripts/scrape-images.ts --missing-only     # only artists showing no picture at all (see below)
//   npx tsx scripts/scrape-images.ts --missing-only --approved
//                                                        # the same run; --approved is a no-op here (see below)
//   npx tsx scripts/scrape-images.ts --limit=20         # only the first 20 (for testing)
//   npx tsx scripts/scrape-images.ts --list             # print who owns each platform, then exit
//   npx tsx scripts/scrape-images.ts --force            # re-check platforms that already have a stored image
//                                                        # or a definitive no-image result
//   npx tsx scripts/scrape-images.ts --platforms=resident_advisor,discogs
//                                                        # only try these platforms
//   DRY_RUN=1 npx tsx scripts/scrape-images.ts          # fetch + log, don't write to the DB
//
// --missing-only narrows the run to artists with no displayable image
// stored, i.e. the ones whose cards and profile pages currently show
// nothing. It's the "fill the visible gaps first" mode: a full run walks
// every approved artist and spends two DB round-trips each just to
// rediscover that most are already covered, whereas this loads
// artist_images once up front and skips those artists outright. Coverage
// is judged by the same rule the front end renders by (isDisplayablePlatform
// in src/lib/artist-images.ts), so an artist whose only stored image is a
// held-back one — linktree today — still counts as missing, because the
// site shows them nothing.
//
// It is not a substitute for a full run: an artist who already has, say,
// a spotify image but has since gained a youtube link is invisible to
// this mode. Use it to get pictures onto the site quickly, and a plain
// run to complete everyone's coverage.
//
// --approved is accepted so the orchestrator's directory-only flag can be
// passed through (and so it can be combined with --missing-only), but it
// changes nothing: this script is unconditionally approved-only — the
// guard lives inside scrapeArtistImages() itself.
//
// No cache file — state lives in the DB. A platform is skipped once
// artist_images has a row for it, or once harvest_failures has a
// definitive row for it (service = "image:<platform>" — see
// src/lib/images/failures.ts). The skip is keyed to the exact link: both records store
// the profile URL they came from, so a link edited/corrected to a
// different URL is treated as never-tried and re-fetched automatically,
// force or not. If a link changes to a page with no image, the stale
// image previously stored for that platform is deleted. See
// src/lib/scrape-images.ts for the full skip-set rules.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scrapeArtistImages,
  OWNED_BY_DEDICATED_HARVESTER,
  PLATFORM_PRIORITY,
} from "../src/lib/scrape-images.js";
import { isDisplayablePlatform } from "../src/lib/artist-images.js";
import { createStageLogger } from "./lib/progress-log.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const LIST_ONLY = args.includes("--list");
// Only artists with nothing showing on the site — see the header.
const MISSING_ONLY = args.includes("--missing-only");
// Accepted and ignored: this script is unconditionally approved-only, so
// the flag is recognised (rather than silently swallowed) purely so it
// can be passed alongside the others without looking like it did
// something. Reported in the run header below.
const APPROVED_FLAG = args.includes("--approved");
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

// --list only reports how the platforms are divided up, so it stays
// usable without credentials — the question it answers is most often
// asked by someone who hasn't set the project up yet.
if (!LIST_ONLY && (!SUPABASE_URL || !SECRET_KEY)) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}

// Built on first use rather than at import, so --list (which needs no DB)
// doesn't fail on a missing URL before it can print anything.
let client: SupabaseClient | null = null;
function supabaseClient(): SupabaseClient {
  client ??= createClient(SUPABASE_URL!, SECRET_KEY!, {
    auth: { persistSession: false },
  });
  return client;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
/**
 * Print which source owns each platform's images and what role this
 * script plays for it, so "where does a spotify image come from?" is
 * answerable by running one command rather than reading five scripts.
 */
function printOwnershipTable() {
  const OWNERS: Record<string, string> = {
    soundcloud: "sync-soundcloud.mjs (SoundCloud /resolve API)",
    bandcamp: "sync-bandcamp.mjs (artist page sidebar)",
  };
  console.log("Image ownership by platform\n");
  const width = Math.max(...PLATFORM_PRIORITY.map((p) => p.length));
  for (const platform of PLATFORM_PRIORITY) {
    const owner = OWNERS[platform];
    console.log(
      `  ${platform.padEnd(width)}  ${owner ?? "this script (og:image scrape)"}` +
        (owner ? "  — scraped here only after a transient failure" : "")
    );
  }
  console.log(
    `\nharvest_failures key: image:<platform>. A definitive status means the ` +
      `answer is known;\na transient one is retried, and is what makes an owned ` +
      `platform eligible for a scrape.\n`
  );
}

/**
 * Every artist_id with at least one image the site would actually
 * display — the set --missing-only subtracts from the approved artists.
 *
 * One paged sweep of artist_images rather than a per-artist existence
 * check: the whole point of the mode is to avoid a round-trip per
 * artist. Paged on the (artist_id, platform) primary key, not on
 * artist_id alone, because a non-unique sort key lets Postgres order
 * ties differently between pages and silently drop rows across the
 * boundary — a dropped row here would put an already-covered artist back
 * into the run, so it costs correctness of the filter, not just tidiness.
 */
async function loadCoveredArtistIds(log: (line: string) => void): Promise<Set<string>> {
  const PAGE_SIZE = 1000;
  const covered = new Set<string>();
  let rows = 0;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabaseClient()
      .from("artist_images")
      .select("artist_id, platform")
      .order("artist_id")
      .order("platform")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!page || page.length === 0) break;
    rows += page.length;
    for (const row of page) {
      // A held-back platform (linktree) isn't coverage — the artist
      // still shows nothing. Same rule the front end renders by.
      if (isDisplayablePlatform(row.platform as string)) covered.add(row.artist_id as string);
    }
    if (page.length < PAGE_SIZE) break;
  }
  log(`--missing-only: ${rows} stored image(s) covering ${covered.size} artist(s).`);
  return covered;
}

async function main() {
  if (LIST_ONLY) {
    printOwnershipTable();
    return;
  }
  // Created after the --list early return, so the report-only mode
  // doesn't open a log file. Per-artist detail lines go to the log file
  // (shared with the whole orchestration when run under it), the
  // console gets a progress bar — see scripts/lib/progress-log.mjs.
  const logger = createStageLogger("scrape-images");
  logger.info(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running image scraping\n");
  if (FORCE) {
    logger.info(
      `--force: re-checking platforms that already have a stored image or a definitive no-image result ` +
        `(${[...OWNED_BY_DEDICATED_HARVESTER].join(", ")} still only scraped after their owner fails transiently)\n`
    );
  }
  if (ALLOWED_PLATFORMS) {
    logger.info(`Restricted to platforms: ${ALLOWED_PLATFORMS.join(", ")}\n`);
  }
  if (MISSING_ONLY) {
    logger.info(
      "--missing-only: restricting to approved artists with no displayable image stored " +
        "(the ones currently showing no picture on the site).\n"
    );
  }
  if (APPROVED_FLAG) {
    logger.info(
      "--approved: no-op here — this script is unconditionally approved-only " +
        "(enforced inside scrapeArtistImages, not by this flag).\n"
    );
  }

  const covered = MISSING_ONLY ? await loadCoveredArtistIds(logger.info) : null;

  // PostgREST caps a single response at ~1000 rows, so a bare select
  // only ever returns the first 1000 approved artists (alphabetically,
  // most already fully covered) and never reaches the rest. Page through
  // in 1000-row batches so every approved artist is checked. --limit
  // still stops early, for testing.
  const PAGE_SIZE = 1000;
  const artists: { id: string; name: string }[] = [];
  // Counted per page rather than derived from the totals at the end,
  // which --limit's truncation would make wrong.
  let skippedCovered = 0;
  for (let from = 0; ; from += PAGE_SIZE) {
    // --limit is normally pushed into the range so the DB returns only
    // what's needed. Under --missing-only it can't be: rows are dropped
    // after they arrive, so pages must come back full and the cap is
    // applied to what survives the filter (below) instead.
    const to = LIMIT && !covered ? Math.min(from + PAGE_SIZE, LIMIT) - 1 : from + PAGE_SIZE - 1;
    const { data: page, error } = await supabaseClient()
      .from("artists")
      .select("id, name")
      .eq("directory_status", "approved")
      .eq("deleted", false)
      .order("name")
      .range(from, to);
    if (error) throw error;
    if (!page || page.length === 0) break;
    const kept = covered ? page.filter((a) => !covered.has(a.id)) : page;
    skippedCovered += page.length - kept.length;
    artists.push(...kept);
    if (page.length < PAGE_SIZE || (LIMIT && artists.length >= LIMIT)) break;
  }
  if (LIMIT && artists.length > LIMIT) artists.length = LIMIT;

  logger.info(
    covered
      ? `${artists.length} approved artist(s) with no image to check ` +
          `(${skippedCovered} already covered, skipped).\n`
      : `${artists.length} approved artist(s) to check.\n`
  );

  let storedCount = 0;
  let removedCount = 0;
  let attemptedCount = 0;
  let noActivity = 0;
  let fullyCovered = 0;
  const bySource: Record<string, number> = {};

  const bar = logger.progressBar(artists.length, "image scraping");
  for (const artist of artists) {
    const result = await scrapeArtistImages(artist.id, supabaseClient(), {
      force: FORCE,
      dryRun: DRY_RUN,
      allowedPlatforms: ALLOWED_PLATFORMS,
      // Per-artist lines go to the stage log file, not the console —
      // the console shows the progress bar below.
      log: logger.detail,
    });

    attemptedCount += result.attempted.length;
    removedCount += result.removed.length;

    if (result.stored.length > 0) {
      storedCount += result.stored.length;
      for (const platform of result.stored) bySource[platform] = (bySource[platform] ?? 0) + 1;
      logger.detail(`✓ ${artist.name}: ${result.stored.join(", ")}`);
      bar.tick("ok");
    } else if (result.attempted.length > 0) {
      logger.detail(`✗ ${artist.name}: no image found (tried ${result.attempted.join(", ")})`);
      bar.tick("fail");
    } else if (result.skippedExisting.length + result.skippedProtected.length > 0) {
      // Every candidate platform already has an image, or a confirmed
      // no-image result, or is soundcloud/bandcamp — nothing to do.
      fullyCovered++;
      bar.tick("skip");
    } else {
      // No usable links at all.
      noActivity++;
      bar.tick("skip");
    }
  }
  bar.finish();

  logger.info(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  if (covered) {
    logger.info(`  artists skipped as already pictured: ${skippedCovered}`);
  }
  logger.info(`  images stored:   ${storedCount}`);
  for (const [platform, count] of Object.entries(bySource)) {
    logger.info(`    via ${platform}: ${count}`);
  }
  logger.info(`  stale images removed (link changed to a page with no image): ${removedCount}`);
  logger.info(`  platform attempts with no image found: ${attemptedCount - storedCount}`);
  logger.info(`  artists already fully covered: ${fullyCovered}`);
  logger.info(`  artists with no usable links: ${noActivity}`);
  logger.close();
}

main().catch((err) => {
  console.error("\nEnrichment failed:", err?.message ?? err);
  process.exit(1);
});
