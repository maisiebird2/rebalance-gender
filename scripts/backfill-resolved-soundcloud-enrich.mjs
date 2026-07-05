#!/usr/bin/env node
// ============================================================
// One-off backfill: seed resolved_artists (service =
// 'soundcloud-enrich') for every artist that already has real
// SoundCloud enrichment data, from before this state tracking
// existed. enrich-soundcloud.mjs (Phase 2a) used to track progress
// in enrich-soundcloud-cache.json; that's now replaced by DB-tracked
// state in resolved_artists (see scripts/PIPELINE.md, Phase 2a).
// Without this backfill, the next 2a run would treat every
// already-enriched artist as unprocessed and re-fetch them all.
//
// "Already enriched" = an artist_enrichment row with platform =
// 'soundcloud' and external_id NOT NULL. external_id is the
// SoundCloud numeric user ID, set on every successful resolve
// (enrich-soundcloud.mjs only leaves it null if the API response had
// no user id at all, which doesn't happen for a real profile) — a
// cheaper single-column stand-in for "bio, external_id,
// follower_count, or track_count is set" that in practice matches
// the same rows, since a row with a bio but no external_id shouldn't
// occur given how enrich-soundcloud.mjs builds its upsert payload.
//
// Idempotent: skips artist_ids that already have a resolved_artists
// row for this service, so it's safe to re-run.
//
// resolved_at is stamped with the time this script runs (one
// timestamp for the whole batch) — the original per-artist
// enrichment time isn't tracked anywhere but
// artist_enrichment.last_synced_at, which this script does not read
// or need (state rows just need *a* timestamp, per the plan to seed
// this fresh).
//
// Fetches use keyset pagination (WHERE artist_id > cursor, ordered,
// LIMIT n) rather than OFFSET-based paging, so each round-trip only
// costs what it takes to find the next n matching rows — this is
// what makes --limit actually useful against a statement timeout,
// versus an OFFSET page that still has to walk everything before it.
//
// Usage (from the rebalance-gender/ folder):
//
//   DRY_RUN=1 node scripts/backfill-resolved-soundcloud-enrich.mjs             # preview only, no writes
//   node scripts/backfill-resolved-soundcloud-enrich.mjs
//   node scripts/backfill-resolved-soundcloud-enrich.mjs --limit=200           # smaller batches per DB round-trip
//   node scripts/backfill-resolved-soundcloud-enrich.mjs --after=<artist_id>  # resume after this artist_id
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const STATE_SERVICE = "soundcloud-enrich"; // resolved_artists.service value

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

// ------------------------------------------------------------
// Keyset-paginated fetch (WHERE artist_id > cursor, ORDER BY
// artist_id, LIMIT n) instead of OFFSET-based .range() — an OFFSET
// page still has to walk (and, for a filtered/unindexed condition,
// often sort) everything before it, which is almost certainly why
// the original .range()-based query hit a statement timeout on a
// large artist_enrichment table. Keyset pagination lets Postgres
// seek straight to the cursor and stop as soon as it has `pageSize`
// matches, so a smaller page (via --limit) directly buys a cheaper,
// less timeout-prone query.
// ------------------------------------------------------------
const PAGE_SIZE = 1000;

async function fetchEnrichedArtistIds({ limit = null, after = null } = {}) {
  const pageSize = limit ? Math.min(limit, PAGE_SIZE) : PAGE_SIZE;
  const ids = [];
  let cursor = after;

  while (true) {
    let query = supabase
      .from("artist_enrichment")
      .select("artist_id")
      .eq("platform", "soundcloud")
      .not("external_id", "is", null)
      .order("artist_id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("artist_id", cursor);

    const { data, error } = await query;
    if (error) throw error;

    ids.push(...data.map((r) => r.artist_id));
    if (data.length < pageSize) break; // no more rows
    cursor = data[data.length - 1].artist_id;
    if (limit && ids.length >= limit) break;
  }

  return limit ? ids.slice(0, limit) : ids;
}

async function fetchAlreadyMarkedArtistIds() {
  const ids = new Set();
  let cursor = null;
  while (true) {
    let query = supabase
      .from("resolved_artists")
      .select("artist_id")
      .eq("service", STATE_SERVICE)
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
      : `Backfilling resolved_artists (service = ${STATE_SERVICE})\n`
  );
  if (LIMIT) console.log(`--limit=${LIMIT} (also used as the per-request page size)`);
  if (AFTER) console.log(`--after=${AFTER} (resuming after this artist_id)`);

  const resolvedAt = new Date().toISOString();

  const enrichedIds = await fetchEnrichedArtistIds({ limit: LIMIT, after: AFTER });
  console.log(`${enrichedIds.length} artist(s) fetched with real SoundCloud enrichment data.`);

  const alreadyMarked = await fetchAlreadyMarkedArtistIds();
  if (alreadyMarked.size > 0) {
    console.log(`${alreadyMarked.size} already have resolved_artists state for this service.`);
  }

  const targets = enrichedIds.filter((id) => !alreadyMarked.has(id));
  console.log(`${targets.length} to backfill.\n`);

  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.log(`Would write ${targets.length} resolved_artists row(s), resolved_at = ${resolvedAt}`);
    console.log("Sample artist_ids:", targets.slice(0, 10));
    if (LIMIT && enrichedIds.length === LIMIT) {
      console.log(
        `\nHit --limit=${LIMIT} — there may be more. To preview the next batch:\n` +
          `  DRY_RUN=1 node scripts/backfill-resolved-soundcloud-enrich.mjs --limit=${LIMIT} --after=${enrichedIds[enrichedIds.length - 1]}`
      );
    }
    return;
  }

  const BATCH_SIZE = 500;
  let written = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE).map((artist_id) => ({
      artist_id,
      service: STATE_SERVICE,
      resolved_at: resolvedAt,
    }));
    const { error } = await supabase
      .from("resolved_artists")
      .upsert(batch, { onConflict: "artist_id,service" });
    if (error) {
      console.error(`Batch starting at ${i} failed: ${error.message}`);
      continue;
    }
    written += batch.length;
    console.log(`  wrote ${written}/${targets.length}`);
  }

  console.log(`\nDone. ${written} resolved_artists row(s) written for service = ${STATE_SERVICE}.`);
  if (LIMIT && enrichedIds.length === LIMIT) {
    console.log(
      `Hit --limit=${LIMIT} — there may be more. Continue with:\n` +
        `  node scripts/backfill-resolved-soundcloud-enrich.mjs --limit=${LIMIT} --after=${enrichedIds[enrichedIds.length - 1]}`
    );
  }
}

main().catch((err) => {
  console.error("\nBackfill failed:", err?.message ?? err);
  process.exit(1);
});
