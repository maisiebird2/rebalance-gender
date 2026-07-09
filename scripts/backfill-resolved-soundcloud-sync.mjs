#!/usr/bin/env node
// ============================================================
// One-off backfill: seed resolved_artists (service =
// 'soundcloud-sync') for every artist that was already fully synced
// under the old two-script system — i.e. has resolved_artists rows
// for BOTH 'soundcloud-enrich' (old 2a) and 'soundcloud-harvest' (old
// 2b). scripts/sync-soundcloud.mjs replaced those two scripts with a
// single stage tracked under a new service name; without this
// backfill, the merged stage's first run would treat every one of
// those already-synced artists as unprocessed and re-fetch them all
// from SoundCloud from scratch. Same idea as
// backfill-resolved-soundcloud-enrich.mjs did for the original
// cache-file → resolved_artists switch — see scripts/PIPELINE.md.
//
// "Fully synced under the old system" = has a resolved_artists row
// for service='soundcloud-enrich' AND a row for
// service='soundcloud-harvest'. An artist with only one of the two
// (e.g. 2a succeeded but 2b hadn't run yet, or vice versa) is left
// alone — sync-soundcloud.mjs will pick it up on its own next run and
// do the full merged sync for it, which is correct: the old
// 'soundcloud-harvest'-only staged links/bio, or 'soundcloud-enrich'-
// only profile data, don't add up to everything the merged stage now
// writes (harvest_failures clears, artist_harvested_bios audit trail,
// etc.), so it's worth a real (cheap, 2-call) resync rather than a
// blind state copy.
//
// Idempotent: skips artist_ids that already have a resolved_artists
// row for 'soundcloud-sync', so it's safe to re-run.
//
// Uses keyset pagination (WHERE artist_id > cursor, ORDER BY
// artist_id, LIMIT n) rather than OFFSET-based paging — same reason
// as backfill-resolved-soundcloud-enrich.mjs: an OFFSET page over a
// filtered condition still has to walk everything before it, which is
// what caused that script's original .range()-based version to hit a
// Postgres statement timeout.
//
// Usage (from the rebalance-gender/ folder):
//
//   DRY_RUN=1 node scripts/backfill-resolved-soundcloud-sync.mjs            # preview only, no writes
//   node scripts/backfill-resolved-soundcloud-sync.mjs
//   node scripts/backfill-resolved-soundcloud-sync.mjs --limit=200          # smaller batches per DB round-trip
//   node scripts/backfill-resolved-soundcloud-sync.mjs --after=<artist_id>  # resume after this artist_id
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const NEW_SERVICE = "soundcloud-sync";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
// Also used as the per-request page size (capped at PAGE_SIZE below),
// so a smaller --limit means smaller, cheaper DB round-trips, not
// just a smaller final result.
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const afterArg = args.find((a) => a.startsWith("--after="));
const AFTER = afterArg ? afterArg.slice("--after=".length) : null;

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

const PAGE_SIZE = 1000;

// ------------------------------------------------------------
// Keyset-paginated fetch of every artist_id with a resolved_artists
// row for the given service.
// ------------------------------------------------------------
async function fetchServiceArtistIds(service, { limit = null, after = null } = {}) {
  const pageSize = limit ? Math.min(limit, PAGE_SIZE) : PAGE_SIZE;
  const ids = [];
  let cursor = after;

  while (true) {
    let query = supabase
      .from("resolved_artists")
      .select("artist_id")
      .eq("service", service)
      .order("artist_id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("artist_id", cursor);

    const { data, error } = await query;
    if (error) throw error;

    ids.push(...data.map((r) => r.artist_id));
    if (data.length < pageSize) break;
    cursor = data[data.length - 1].artist_id;
    if (limit && ids.length >= limit) break;
  }

  return limit ? ids.slice(0, limit) : ids;
}

async function fetchAlreadyMarkedArtistIds(service) {
  const ids = new Set();
  let cursor = null;
  while (true) {
    let query = supabase
      .from("resolved_artists")
      .select("artist_id")
      .eq("service", service)
      .order("artist_id", { ascending: true })
      .limit(PAGE_SIZE);
    if (cursor) query = query.gt("artist_id", cursor);

    const { data, error } = await query;
    if (error) throw error;

    for (const r of data) ids.add(r.artist_id);
    if (data.length < PAGE_SIZE) break;
    cursor = data[data.length - 1].artist_id;
  }
  return ids;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : `Backfilling resolved_artists (service = ${NEW_SERVICE})\n`
  );
  if (LIMIT) console.log(`--limit=${LIMIT} (also used as the per-request page size)`);
  if (AFTER) console.log(`--after=${AFTER} (resuming after this artist_id)`);

  const resolvedAt = new Date().toISOString();

  // Artists done under BOTH old services — intersect the two id lists.
  // --limit/--after apply to the first (soundcloud-enrich) fetch only,
  // matching backfill-resolved-soundcloud-enrich.mjs's --limit/--after
  // contract (page through the whole candidate set in batches); the
  // second (soundcloud-harvest) fetch is unbounded so the intersection
  // is always correct against a --limit-restricted first page.
  const enrichIds = await fetchServiceArtistIds("soundcloud-enrich", { limit: LIMIT, after: AFTER });
  console.log(`${enrichIds.length} artist(s) fetched with 'soundcloud-enrich' state.`);

  const harvestIds = await fetchServiceArtistIds("soundcloud-harvest");
  const harvestSet = new Set(harvestIds);
  console.log(`${harvestIds.length} artist(s) have 'soundcloud-harvest' state.`);

  const doneUnderOldSystem = enrichIds.filter((id) => harvestSet.has(id));
  console.log(`${doneUnderOldSystem.length} artist(s) have BOTH — fully synced under the old system.`);

  const alreadyMarked = await fetchAlreadyMarkedArtistIds(NEW_SERVICE);
  if (alreadyMarked.size > 0) {
    console.log(`${alreadyMarked.size} already have resolved_artists state for '${NEW_SERVICE}'.`);
  }

  const targets = doneUnderOldSystem.filter((id) => !alreadyMarked.has(id));
  console.log(`${targets.length} to backfill.\n`);

  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.log(`Would write ${targets.length} resolved_artists row(s), resolved_at = ${resolvedAt}`);
    console.log("Sample artist_ids:", targets.slice(0, 10));
    if (LIMIT && enrichIds.length === LIMIT) {
      console.log(
        `\nHit --limit=${LIMIT} — there may be more. To preview the next batch:\n` +
          `  DRY_RUN=1 node scripts/backfill-resolved-soundcloud-sync.mjs --limit=${LIMIT} --after=${enrichIds[enrichIds.length - 1]}`
      );
    }
    return;
  }

  const BATCH_SIZE = 500;
  let written = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE).map((artist_id) => ({
      artist_id,
      service: NEW_SERVICE,
      resolved_at: resolvedAt,
    }));
    const { error } = await supabase.from("resolved_artists").upsert(batch, { onConflict: "artist_id,service" });
    if (error) {
      console.error(`Batch starting at ${i} failed: ${error.message}`);
      continue;
    }
    written += batch.length;
    console.log(`  wrote ${written}/${targets.length}`);
  }

  console.log(`\nDone. ${written} resolved_artists row(s) written for service = ${NEW_SERVICE}.`);
  if (LIMIT && enrichIds.length === LIMIT) {
    console.log(
      `Hit --limit=${LIMIT} — there may be more. Continue with:\n` +
        `  node scripts/backfill-resolved-soundcloud-sync.mjs --limit=${LIMIT} --after=${enrichIds[enrichIds.length - 1]}`
    );
  }
}

main().catch((err) => {
  console.error("\nBackfill failed:", err?.message ?? err);
  process.exit(1);
});
