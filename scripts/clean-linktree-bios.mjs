#!/usr/bin/env node
// ============================================================
// One-time cleanup: strip Linktree URLs (and any leftover "Linktree"
// label text) out of bios already stored in artist_enrichment, and
// add the URL to artist_links (platform = 'linktree') — unless the
// artist already has a linktree link, in which case it's left alone.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/clean-linktree-bios.mjs            # clean all stored SoundCloud bios
//   node scripts/clean-linktree-bios.mjs --limit=20 # only process the first 20 (for testing)
//   DRY_RUN=1 node scripts/clean-linktree-bios.mjs  # log changes, but don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
//
// After this has been run once, enrich-bios.mjs already strips
// Linktree links out of any newly-fetched bios going forward (adding
// them to artist_links the same way), so this script shouldn't need
// to be run again unless old bios are reintroduced.
//
// NOTE: this script used to write the extracted URL to the now-retired
// artists.linktree_url column. If you're looking at existing data in
// that column, see scripts/migrate-linktree-to-links.ts, which moves
// it into artist_links (and flags any conflicts for manual review).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinktree } from "./lib/linktree.mjs";

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

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : "Cleaning Linktree links out of stored bios\n"
  );

  let query = supabase
    .from("artist_enrichment")
    .select("id, artist_id, bio, artists(name)")
    .eq("platform", "soundcloud")
    .not("bio", "is", null);

  if (LIMIT) {
    query = query.limit(LIMIT);
  }

  const { data: rows, error } = await query;
  if (error) throw error;

  // Artists that already have a Linktree link (artist_links, platform =
  // 'linktree'), preloaded once so a URL found in a bio only gets added
  // when the artist doesn't already have one. Paginated — PostgREST
  // caps unpaginated selects at 1000 rows.
  const artistIdsWithLinktree = new Set();
  {
    const PAGE_SIZE = 1000;
    let from = 0;
    while (true) {
      const { data, error: linktreeIdsError } = await supabase
        .from("artist_links")
        .select("artist_id")
        .eq("platform", "linktree")
        .order("artist_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (linktreeIdsError) throw linktreeIdsError;
      for (const r of data ?? []) artistIdsWithLinktree.add(r.artist_id);
      if ((data?.length ?? 0) < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  let changed = 0;
  let unchanged = 0;
  let skippedExisting = 0;

  for (const row of rows) {
    const name = row.artists?.name ?? row.artist_id;
    const { text: cleanedBio, linktreeUrl } = extractLinktree(row.bio);

    if (!linktreeUrl) {
      unchanged++;
      continue;
    }

    const alreadyHasLinktree = artistIdsWithLinktree.has(row.artist_id);

    changed++;
    const newBio = cleanedBio || null;
    console.log(
      `✓ ${name}: linktree -> ${linktreeUrl}${
        alreadyHasLinktree ? " (artist already has a linktree link — not added again)" : ""
      }`
    );
    if (newBio !== row.bio) {
      console.log(
        `  bio: "${row.bio.slice(0, 60)}${row.bio.length > 60 ? "…" : ""}" -> ${
          newBio ? `"${newBio.slice(0, 60)}${newBio.length > 60 ? "…" : ""}"` : "(empty)"
        }`
      );
    }
    if (alreadyHasLinktree) skippedExisting++;

    if (!DRY_RUN) {
      const { error: bioError } = await supabase
        .from("artist_enrichment")
        .update({ bio: newBio })
        .eq("id", row.id);
      if (bioError) {
        console.error(`  failed to update bio: ${bioError.message}`);
      }

      if (!alreadyHasLinktree) {
        const { error: linkError } = await supabase.from("artist_links").upsert(
          { artist_id: row.artist_id, platform: "linktree", url: linktreeUrl },
          { onConflict: "artist_id,platform", ignoreDuplicates: true }
        );
        if (linkError) {
          console.error(`  failed to save linktree link: ${linkError.message}`);
        } else {
          artistIdsWithLinktree.add(row.artist_id);
        }
      }
    }
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  cleaned:                    ${changed}`);
  console.log(`  unchanged:                  ${unchanged}`);
  console.log(`  (artist already had a link): ${skippedExisting}`);
}

main().catch((err) => {
  console.error("\nCleanup failed:", err?.message ?? err);
  process.exit(1);
});
