#!/usr/bin/env node
// ============================================================
// One-time cleanup: remove already-stored placeholder images.
//
// Before enrich-images.ts / sync-soundcloud.mjs learned to reject
// platform default placeholders, some got scraped and stored (and
// re-hosted) as if they were real profile photos:
//
//   - Last.fm's default "star" avatar (og:image scrape) — any
//     artist_images.source_url containing the well-known placeholder
//     hash. Rejected going forward by isPlaceholderImageUrl in
//     src/lib/enrich-images.ts.
//   - SoundCloud's generic grey default_avatar (returned as avatar_url
//     for accounts with no photo). Rejected going forward by
//     isDefaultAvatarUrl in scripts/lib/soundcloud.mjs.
//
// The forward-going code only stops *new* placeholders; existing rows
// are never re-checked (they already have an artist_images row, so
// re-enrichment / the image-only sync pass skip them). This script
// sweeps them out.
//
// For each matched row it does the same three things as
// prune-artist-images.mjs — remove the re-hosted Storage object, delete
// the artist_images row — then, instead of *clearing* harvest_failures,
// it *records* one (image-enrich:<platform> / no_og_image for og
// placeholders, image-sync:soundcloud / default_avatar for SoundCloud),
// with the artist's current link URL. That way the next run treats the
// platform as a known no-image result (skipped until the link changes),
// exactly as if the now-rejecting forward code had produced it — rather
// than immediately re-fetching the same placeholder (an og:image
// re-fetch, or a wasted SoundCloud /resolve API call, per artist).
//
// Idempotent and re-runnable: matched rows are gone after the first
// pass, and the failure upsert is keyed on (artist_id, service).
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/prune-placeholder-images.mjs
//   DRY_RUN=1 node scripts/prune-placeholder-images.mjs   # preview, no writes
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDefaultAvatarUrl } from "./lib/soundcloud.mjs";
import { IMAGE_FAILURE_STATUS, imageFailureService } from "../src/lib/images/failures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "artist-images";
const SUPABASE_PAGE_SIZE = 1000;
const IN_CHUNK = 100;

// og:image placeholders — keep in sync with PLACEHOLDER_IMAGE_PATTERNS /
// isPlaceholderImageUrl in src/lib/enrich-images.ts. Duplicated rather
// than imported: that module is bundled into the Next.js app and this is
// a plain-Node .mjs, the same boundary store-images.mjs's PLATFORM_
// PRIORITY copy already lives with.
const OG_PLACEHOLDER_PATTERNS = [
  // Last.fm default "star" artist avatar (same hash at every size).
  /2a96cbd8b46e442fc41c2b86b821562f/i,
];
function isOgPlaceholderUrl(url) {
  return typeof url === "string" && OG_PLACEHOLDER_PATTERNS.some((re) => re.test(url));
}

// Classify a stored image row as a placeholder, or return null. The
// service/status mirror exactly what the forward-going rejection paths
// record, so the resulting harvest_failures rows are indistinguishable
// from ones the live code produces.
function classifyPlaceholder(row) {
  if (row.platform === "soundcloud" && isDefaultAvatarUrl(row.source_url)) {
    return {
      service: imageFailureService("soundcloud"),
      status: IMAGE_FAILURE_STATUS.PLACEHOLDER,
      detail: "soundcloud returned its default placeholder avatar (no real photo)",
    };
  }
  if (isOgPlaceholderUrl(row.source_url)) {
    return {
      service: imageFailureService(row.platform),
      status: IMAGE_FAILURE_STATUS.PLACEHOLDER,
      detail: "placeholder image (platform default, no real photo)",
    };
  }
  return null;
}

// ------------------------------------------------------------
// All artist_images rows (paginated — PostgREST caps at 1000).
// ------------------------------------------------------------
async function fetchAllImages() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("artist_images")
      .select("artist_id, platform, source_url, storage_path")
      .order("artist_id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return all;
}

// ------------------------------------------------------------
// Current artist_links URL for each matched (artist_id, platform) pair,
// so the recorded failure carries the link the harvester compares
// against (its "has the link changed since?" cross-check). Keyed
// `${artist_id}:${platform}`; pairs with no live link are simply absent
// (url recorded as null — such an artist isn't a harvest candidate
// anyway).
// ------------------------------------------------------------
async function fetchLinkUrls(matched) {
  const artistIds = Array.from(new Set(matched.map((r) => r.artist_id)));
  const wantedPlatforms = new Set(matched.map((r) => r.platform));
  const map = new Map();
  for (let i = 0; i < artistIds.length; i += IN_CHUNK) {
    const chunk = artistIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from("artist_links")
      .select("artist_id, platform, url")
      .in("artist_id", chunk)
      .not("url", "is", null);
    if (error) throw error;
    for (const l of data) {
      if (!wantedPlatforms.has(l.platform)) continue;
      const key = `${l.artist_id}:${l.platform}`;
      if (!map.has(key)) map.set(key, l.url); // first non-null link per pair
    }
  }
  return map;
}

function groupArtistIdsByPlatform(rows) {
  const byPlatform = new Map();
  for (const r of rows) {
    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
    byPlatform.get(r.platform).push(r.artist_id);
  }
  return byPlatform;
}

async function main() {
  console.log(DRY_RUN ? "DRY RUN — no writes\n" : "Pruning stored placeholder images\n");

  const images = await fetchAllImages();
  const matched = [];
  const byStatus = {};
  for (const row of images) {
    const cls = classifyPlaceholder(row);
    if (!cls) continue;
    matched.push({ ...row, ...cls });
    byStatus[cls.status] = (byStatus[cls.status] ?? 0) + 1;
  }

  console.log(`${matched.length} placeholder image row(s) matched (of ${images.length} total).`);
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${count}`);
  }
  if (matched.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const linkUrls = await fetchLinkUrls(matched);
  const storagePaths = matched.map((r) => r.storage_path).filter(Boolean);
  console.log(`  ${storagePaths.length} of them have a re-hosted Storage object to remove.\n`);

  if (DRY_RUN) {
    for (const row of matched.slice(0, 20)) {
      const url = linkUrls.get(`${row.artist_id}:${row.platform}`) ?? "(no live link)";
      console.log(
        `  would remove: ${row.artist_id} — ${row.platform} [${row.status}] link=${url}` +
          `${row.storage_path ? ` storage=${row.storage_path}` : ""}`
      );
    }
    if (matched.length > 20) console.log(`  … and ${matched.length - 20} more`);
    console.log("\nDry run — nothing changed.");
    return;
  }

  // 1. Storage objects (batched). Stop before touching the DB if this
  // fails, same as prune-artist-images.mjs.
  if (storagePaths.length > 0) {
    for (let i = 0; i < storagePaths.length; i += IN_CHUNK) {
      const chunk = storagePaths.slice(i, i + IN_CHUNK);
      const { error } = await supabase.storage.from(BUCKET).remove(chunk);
      if (error) {
        console.error(`Failed to remove Storage objects: ${error.message}`);
        console.error("Stopping before touching the database — re-run once Storage removal succeeds.");
        process.exit(1);
      }
    }
    console.log(`Removed ${storagePaths.length} Storage object(s).`);
  }

  // 2. artist_images rows — delete exactly the matched (artist_id,
  // platform) pairs, batched per platform (deleting by artist_id alone
  // would take out that artist's other, real images).
  let deleted = 0;
  for (const [platform, artistIds] of groupArtistIdsByPlatform(matched)) {
    for (let i = 0; i < artistIds.length; i += IN_CHUNK) {
      const chunk = artistIds.slice(i, i + IN_CHUNK);
      const { error, count } = await supabase
        .from("artist_images")
        .delete({ count: "exact" })
        .eq("platform", platform)
        .in("artist_id", chunk);
      if (error) {
        console.error(`Failed to delete artist_images rows for ${platform}: ${error.message}`);
        process.exit(1);
      }
      deleted += count ?? chunk.length;
    }
  }
  console.log(`Deleted ${deleted} artist_images row(s).`);

  // 3. Record a harvest_failures row per pruned image so the next run
  // treats it as a known no-image result rather than re-fetching.
  const failureRows = matched.map((r) => ({
    artist_id: r.artist_id,
    service: r.service,
    status: r.status,
    detail: r.detail,
    url: linkUrls.get(`${r.artist_id}:${r.platform}`) ?? null,
    occurred_at: new Date().toISOString(),
  }));
  let recorded = 0;
  for (let i = 0; i < failureRows.length; i += 500) {
    const chunk = failureRows.slice(i, i + 500);
    const { error } = await supabase
      .from("harvest_failures")
      .upsert(chunk, { onConflict: "artist_id,service" });
    if (error) {
      console.error(`Failed to record harvest_failures rows: ${error.message}`);
      process.exit(1);
    }
    recorded += chunk.length;
  }
  console.log(`Recorded ${recorded} harvest_failures row(s) (no-image results).`);

  console.log("\nDone. Placeholder images removed and recorded as no-image results.");
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
