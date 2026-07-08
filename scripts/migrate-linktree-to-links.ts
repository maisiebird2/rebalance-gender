#!/usr/bin/env tsx
// ============================================================
// One-time migration: move artists.linktree_url values into
// artist_links (platform = 'linktree'), so a Linktree link lives in
// exactly one place going forward — same as every other platform.
// (enrich-bios.mjs and enrich-soundcloud.mjs already write new finds
// there instead of linktree_url; this script cleans up what's left
// over from before that change.)
//
// For each artist with a non-null linktree_url:
//
//   - No existing artist_links row for 'linktree' -> the URL is
//     inserted into artist_links (normalized with cleanLinkUrl /
//     resolveProfileLinkUrl, the same functions the app uses to clean
//     any submitted profile link), and linktree_url is cleared.
//
//   - An artist_links row for 'linktree' already exists -> both URLs
//     are normalized the same way and compared:
//       - same       -> linktree_url is just cleared; the artist_links
//                       row already has it, nothing to insert.
//       - different  -> nothing is written or cleared. The conflict is
//                       printed for manual review. This script never
//                       overwrites an existing artist_links row — same
//                       rule integrate-harvested-links.mjs follows for
//                       harvested links.
//
// Usage (from the rebalance-gender/ folder):
//
//   npx tsx scripts/migrate-linktree-to-links.ts            # run for real
//   npx tsx scripts/migrate-linktree-to-links.ts --limit=20 # first 20 only (testing)
//   DRY_RUN=1 npx tsx scripts/migrate-linktree-to-links.ts  # log only, no writes
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
//
// Safe to re-run: an artist is only picked up while linktree_url is
// still non-null, so a clean run leaves nothing for the next one
// except any flagged conflicts (which are intentionally left as-is
// until a human resolves them).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanLinkUrl } from "../src/lib/platforms.js";
import { resolveProfileLinkUrl } from "../src/lib/profile-links.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

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

// Normalizes a Linktree URL the same way the app does when a link is
// submitted or edited: cleanLinkUrl (trim + strip a tracking query
// string — 'linktree' has no search-path exception), then
// resolveProfileLinkUrl's trailing-slash strip. 'linktree' isn't a
// templated platform (see src/lib/profile-links.ts), so this is just
// cleanLinkUrl + stripTrailingSlash — the same treatment every
// non-templated platform link gets on save.
function normalize(url: string): string {
  return resolveProfileLinkUrl("linktree", url.trim(), cleanLinkUrl);
}

interface ArtistRow {
  id: string;
  name: string;
  linktree_url: string | null;
  links: { platform: string; url: string | null }[];
}

// PostgREST caps unpaginated selects at 1000 rows — page through.
const PAGE_SIZE = 1000;

async function fetchArtistsWithLinktreeUrl(): Promise<ArtistRow[]> {
  const rows: ArtistRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, linktree_url, links:artist_links(platform, url)")
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

async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : "Migrating artists.linktree_url -> artist_links (platform = 'linktree')\n"
  );

  let artists = await fetchArtistsWithLinktreeUrl();
  console.log(`Found ${artists.length} artist(s) with a linktree_url set.\n`);
  if (LIMIT) artists = artists.slice(0, LIMIT);

  let moved = 0;
  let clearedAsMatch = 0;
  let conflicts = 0;
  let errors = 0;

  for (const artist of artists) {
    const rawUrl = (artist.linktree_url ?? "").trim();
    if (!rawUrl) continue;

    const cleanedFromArtist = normalize(rawUrl);
    const existing = (artist.links ?? []).find((l) => l.platform === "linktree");

    if (!existing) {
      console.log(`→ ${artist.name}: move "${rawUrl}" to artist_links`);
      if (!DRY_RUN) {
        const { error: insertError } = await supabase.from("artist_links").insert({
          artist_id: artist.id,
          platform: "linktree",
          url: cleanedFromArtist,
          original_url: rawUrl,
        });
        if (insertError) {
          errors++;
          console.error(`  failed to insert artist_links row: ${insertError.message}`);
          continue;
        }
        const { error: clearError } = await supabase
          .from("artists")
          .update({ linktree_url: null })
          .eq("id", artist.id);
        if (clearError) {
          errors++;
          console.error(`  failed to clear linktree_url: ${clearError.message}`);
          continue;
        }
      }
      moved++;
      continue;
    }

    const cleanedExisting = existing.url ? normalize(existing.url) : "";

    if (cleanedExisting === cleanedFromArtist) {
      console.log(`= ${artist.name}: matches artist_links already — clearing linktree_url`);
      if (!DRY_RUN) {
        const { error: clearError } = await supabase
          .from("artists")
          .update({ linktree_url: null })
          .eq("id", artist.id);
        if (clearError) {
          errors++;
          console.error(`  failed to clear linktree_url: ${clearError.message}`);
          continue;
        }
      }
      clearedAsMatch++;
    } else {
      conflicts++;
      console.log(
        `✗ ${artist.name}: CONFLICT — artists.linktree_url ("${rawUrl}") differs from ` +
          `the existing artist_links row ("${existing.url}"). Left both in place for manual review.`
      );
    }
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  moved (new artist_links row):            ${moved}`);
  console.log(`  already matched (linktree_url cleared):  ${clearedAsMatch}`);
  console.log(`  conflicts (needs manual review):         ${conflicts}`);
  console.log(`  errors:                                  ${errors}`);
}

main().catch((err) => {
  console.error("\nMigration failed:", err?.message ?? err);
  process.exit(1);
});
