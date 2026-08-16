#!/usr/bin/env tsx
// ============================================================
// One-time migration: move artists.linktree_url values into the
// artist_harvested_links staging table, so a Linktree link lives in
// exactly one place going forward — same as every other platform.
//
// The column is legacy: nothing writes to it any more (enrich-bios.mjs
// and sync-soundcloud.mjs stage new finds instead), so this only cleans
// up what was left behind before that change.
//
// Why staging and not artist_links directly. Every link an automated
// process discovers goes into artist_harvested_links FIRST and is
// promoted to artist_links by integrate-harvested-links.mjs (Phase 2d).
// That is what gives one place — 2d — the dedup, the conflict flagging
// (artist_links_url), the "not found" collision handling and the
// shortener resolution. This script used to insert into artist_links
// itself and carry its own conflict-comparison logic; it doesn't any
// more. It stages, and 2d decides. (The file name is unchanged: the
// links still end up in artist_links, just by the proper route.)
//
// For each artist with a non-null linktree_url:
//
//   - The URL is classified by domain against the SHARED platform table
//     (src/lib/classify-platform-url.ts) with no per-harvester options.
//     A linktr.ee URL classifies as 'linktree'; a URL saved in the wrong
//     field — the column is hand-entered, so this happens — is staged
//     under whatever platform it really belongs to rather than being
//     mislabelled 'linktree'. CLASSIFY_CONFIGS.linktree is deliberately
//     NOT used here: it skips linktr.ee hosts as self-links, which is
//     right when reading a Linktree page and would drop every row here.
//
//   - One artist_harvested_links row is staged:
//       source_platform  'linktree'
//       source_url       the value as stored in the column
//       raw_url          the same value, exactly as stored
//       parsed_platform  the classified platform key
//       parsed_url       the normalized URL (https, lowercased host, no
//                        fragment, no trailing slash) — the same shape
//                        the other harvesters stage
//     The insert is an upsert on (artist_id, parsed_url) with
//     ignoreDuplicates, so a URL already staged by a harvester is left
//     alone rather than colliding with the unique constraint.
//
//   - Only once that row is safely in staging is linktree_url cleared.
//     A conflict with an existing artist_links row is NOT this script's
//     business: it stages the candidate and 2d flags the discrepancy in
//     artist_links_url for a human, exactly as it does for every
//     harvested link.
//
//   - A value that can't be classified — unparseable, a non-http(s)
//     scheme (mailto:), or a policy-skipped host (twitter/x) — is left
//     in the column untouched and listed at the end for manual review.
//     A scheme-less value ("linktr.ee/someone") gets an https:// prefix
//     before classification; those are counted separately in the
//     summary so the assumption is visible.
//
// Usage (from the rebalance-gender/ folder):
//
//   npm run migrate-linktree-to-links               # run for real
//   npm run migrate-linktree-to-links -- --limit=20 # first 20 only (testing)
//   DRY_RUN=1 npm run migrate-linktree-to-links     # log only, no writes
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
//
// Safe to re-run: an artist is only picked up while linktree_url is
// still non-null, and both writes are idempotent (the staging upsert
// ignores duplicates; clearing an already-null column is a no-op). A
// clean run leaves nothing for the next one except the values flagged
// as unusable, which are intentionally left as-is until a human
// resolves them.
//
// Follow-up: once this has run clean, artists.linktree_url holds
// nothing and can be dropped with a migration in migrations/.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPlatformUrl } from "../src/lib/classify-platform-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// The value written to artist_harvested_links.source_platform for every
// row this script stages: the link IS a Linktree link (or was filed as
// one), and 'linktree' is the key sync-linktree.mjs already stages under.
const SOURCE_PLATFORM = "linktree";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

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
// URL classification + normalization.
//
// Same shape the other harvesters stage: https, lowercased host, no
// fragment, no trailing slash. The query string is kept — 2d applies
// cleanLinkUrl / resolveProfileLinkUrl when it promotes, and stripping
// it here would throw away a search-path query that the promotion step
// knows how to keep.
// ------------------------------------------------------------
function normalizeUrl(url: URL): string {
  const u = new URL(url.toString());
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

interface Classified {
  platform: string;
  parsedUrl: string;
  /** True when an https:// prefix had to be added to make the value parse. */
  schemeAdded: boolean;
}

function classify(rawUrl: string): Classified | null {
  // Hand-entered values sometimes lack a scheme ("linktr.ee/someone"),
  // which new URL() rejects outright. Try as-is first so an existing
  // http:// value keeps its own reading, then retry with https://.
  const attempts: { url: string; schemeAdded: boolean }[] = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl)
    ? [{ url: rawUrl, schemeAdded: false }]
    : [
        { url: rawUrl, schemeAdded: false },
        { url: `https://${rawUrl}`, schemeAdded: true },
      ];

  for (const attempt of attempts) {
    // Shared domain table, no per-harvester options — see the header for
    // why CLASSIFY_CONFIGS.linktree must not be used here. Returns null
    // for unparseable / non-http(s) / policy-skipped hosts.
    const platform = classifyPlatformUrl(attempt.url);
    if (!platform) continue;
    return {
      platform,
      parsedUrl: normalizeUrl(new URL(attempt.url)),
      schemeAdded: attempt.schemeAdded,
    };
  }
  return null;
}

interface ArtistRow {
  id: string;
  name: string;
  linktree_url: string | null;
}

// PostgREST caps unpaginated selects at 1000 rows — page through.
const PAGE_SIZE = 1000;

async function fetchArtistsWithLinktreeUrl(): Promise<ArtistRow[]> {
  const rows: ArtistRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, linktree_url")
      .not("linktree_url", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as ArtistRow[]));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function clearColumn(artistId: string): Promise<string | null> {
  const { error } = await supabase
    .from("artists")
    .update({ linktree_url: null })
    .eq("id", artistId);
  return error ? error.message : null;
}

async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : "Migrating artists.linktree_url -> artist_harvested_links (staged for 2d)\n"
  );

  let artists = await fetchArtistsWithLinktreeUrl();
  console.log(`Found ${artists.length} artist(s) with a linktree_url set.\n`);
  if (LIMIT) artists = artists.slice(0, LIMIT);

  let staged = 0;
  let alreadyStaged = 0;
  let schemeAdded = 0;
  let blankCleared = 0;
  let errors = 0;
  const unusable: { name: string; url: string }[] = [];

  for (const artist of artists) {
    const rawUrl = (artist.linktree_url ?? "").trim();

    // Whitespace-only value: no link to move, so just clear it rather
    // than leave a row that every future run has to re-examine.
    if (!rawUrl) {
      console.log(`· ${artist.name}: blank linktree_url — clearing`);
      if (!DRY_RUN) {
        const clearError = await clearColumn(artist.id);
        if (clearError) {
          errors++;
          console.error(`  failed to clear linktree_url: ${clearError}`);
          continue;
        }
      }
      blankCleared++;
      continue;
    }

    const classified = classify(rawUrl);
    if (!classified) {
      unusable.push({ name: artist.name, url: rawUrl });
      console.log(
        `✗ ${artist.name}: cannot classify "${rawUrl}" — left in the column for manual review`
      );
      continue;
    }
    if (classified.schemeAdded) schemeAdded++;

    const label =
      classified.platform === "linktree"
        ? classified.parsedUrl
        : `${classified.parsedUrl} [as ${classified.platform}]`;
    console.log(`→ ${artist.name}: stage ${label}`);

    if (DRY_RUN) {
      staged++;
      continue;
    }

    // Stage first, clear second. If the insert fails the column still
    // holds the only copy of the URL, and the next run retries it.
    const { data: inserted, error: insertError } = await supabase
      .from("artist_harvested_links")
      .upsert(
        {
          artist_id: artist.id,
          source_platform: SOURCE_PLATFORM,
          source_url: rawUrl,
          raw_url: rawUrl,
          parsed_platform: classified.platform,
          parsed_url: classified.parsedUrl,
        },
        { onConflict: "artist_id,parsed_url", ignoreDuplicates: true }
      )
      .select("id");
    if (insertError) {
      errors++;
      console.error(`  failed to stage artist_harvested_links row: ${insertError.message}`);
      continue;
    }

    // ignoreDuplicates returns no row when this artist already had a
    // staging row for the same parsed_url — the URL is already safely
    // in staging, so the column can still be cleared.
    const wasInserted = (inserted?.length ?? 0) > 0;
    if (wasInserted) {
      staged++;
    } else {
      alreadyStaged++;
      console.log("  (already staged by a harvester — clearing the column only)");
    }

    const clearError = await clearColumn(artist.id);
    if (clearError) {
      errors++;
      console.error(`  failed to clear linktree_url: ${clearError}`);
    }
  }

  if (unusable.length > 0) {
    console.log(`\nLeft in artists.linktree_url for manual review (${unusable.length}):`);
    for (const row of unusable) console.log(`  ${row.name}: ${row.url}`);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  staged (new artist_harvested_links row):  ${staged}`);
  console.log(`  already staged (column cleared only):     ${alreadyStaged}`);
  console.log(`  blank values cleared:                     ${blankCleared}`);
  console.log(`  https:// prefix assumed:                  ${schemeAdded}`);
  console.log(`  unusable (left for manual review):        ${unusable.length}`);
  console.log(`  errors:                                   ${errors}`);
  console.log(
    "\nStaged rows are promoted into artist_links by Phase 2d:\n  npm run integrate-harvested-links"
  );
}

main().catch((err) => {
  console.error("\nMigration failed:", err?.message ?? err);
  process.exit(1);
});
