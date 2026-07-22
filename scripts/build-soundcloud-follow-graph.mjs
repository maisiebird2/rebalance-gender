#!/usr/bin/env node
// ============================================================
// SoundCloud follow-graph builder for the recommendation engine.
//
// For every directory artist (directory_status = 'approved') with a
// SoundCloud link, pulls who THEY follow (never who follows them —
// followers are unbounded/fan-dominated, followings are bounded by
// the artist's own intentional behavior, per the recommendation
// engine design brief) via the official SoundCloud API, and:
//
//   1. Writes one row per (follower, followed) pair to
//      sc_follow_edges.
//   2. For any followed account not already in the `artists` table
//      (matched by their SoundCloud profile URL), creates a new
//      artist row with directory_status = 'sc_followee' and a
//      `soundcloud` artist_links row — this is the primary mechanism
//      by which non-directory artists (e.g. male DJs, or potential
//      future directory members not yet discovered) enter the graph.
//      'sc_followee' marks "discovered via the follow graph, never
//      reviewed" — distinct from 'not_eligible', which is reserved for
//      artists a human has actually looked at and ruled out.
//
// Source directory artists are NOT enriched here (as of 2026-07-11):
// sync-soundcloud.mjs (Phase 2a) owns the full SoundCloud pull for
// directory artists — bio, image, and staged links — so this builder
// only resolves a source artist to get their urn (for the followings
// call) and records follow-graph state on their soundcloud
// `artist_enrichment` row (follow_graph_built_at / sync_error).
//
// Newly-discovered followed artists (from the followings collection,
// which returns each followee's full user object at no extra API cost)
// ARE enriched, minimally: only follower_count (to weed out non-artist /
// low-signal accounts) and external_id go to `artist_enrichment`; the
// bio goes to the `biographies` table (platform='soundcloud', kept for
// cross-source deduplication); the full raw user object goes to
// `api_response_cache` (namespace 'soundcloud_user') for future
// re-processing. No track_count and no image for these non-directory
// nodes. Already-existing followed artists are not re-enriched here.
//
// Uses the OFFICIAL SoundCloud API (api.soundcloud.com) via the shared
// client in scripts/lib/soundcloud.mjs (OAuth Client Credentials flow),
// the same client sync-soundcloud.mjs uses.
// Requires SoundCloud API credentials (Client ID + Secret), which
// requires a SoundCloud account on the Artist Pro plan:
//   1. https://soundcloud.com/you/apps/new (while signed in)
//   2. Copy the Client ID / Client Secret into .env.local as
//      SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET
// (also requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, as
// with the other scripts in this folder.)
//
// Usage (from the rebalance-gender/ folder):
//
//   npx tsx scripts/build-soundcloud-follow-graph.mjs                  # all approved artists not yet processed
//   npx tsx scripts/build-soundcloud-follow-graph.mjs --limit=5        # only the next 5 unprocessed source artists (for testing)
//   npx tsx scripts/build-soundcloud-follow-graph.mjs --force          # re-pull all artists, including already-processed ones
//   npx tsx scripts/build-soundcloud-follow-graph.mjs --debug          # log every followed account considered
//   npx tsx scripts/build-soundcloud-follow-graph.mjs --max-followings=200
//                                                                    # cap how many followings are pulled per source artist (default 500; 0 = unlimited)
//   npx tsx scripts/build-soundcloud-follow-graph.mjs --name=jeanne    # only source artists whose name matches (testing a single artist)
//   DRY_RUN=1 npx tsx scripts/build-soundcloud-follow-graph.mjs        # fetch + log, don't write to the DB
//
// Start with --limit (and/or --name) on a small batch before running
// the full ~1,400 — a single popular artist's followings list can run
// into the hundreds of API calls once you add pagination, and every
// previously-unseen followed account becomes a new row in `artists`.
//
// Progress is tracked in the database (artist_enrichment.follow_graph_built_at)
// rather than a local cache file. Artists with a dead SoundCloud link are
// recorded with sync_error = 'resolve_failed' and skipped on future runs.
// Fixing the URL in artist_links automatically clears both fields via a DB
// trigger, queuing the artist for re-processing on the next run.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanArtistName } from "./lib/name-utils.mjs";
import { createSoundcloudClient, sleep, normalizeScUrl, cleanScUrl } from "./lib/soundcloud.mjs";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DEBUG = args.includes("--debug");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;
const maxFollowingsArg = args.find((a) => a.startsWith("--max-followings="));
const MAX_FOLLOWINGS = maxFollowingsArg ? parseInt(maxFollowingsArg.split("=")[1], 10) : 500;
// 0 means unlimited
const FOLLOWINGS_CAP = MAX_FOLLOWINGS === 0 ? Infinity : MAX_FOLLOWINGS;

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
const SOUNDCLOUD_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const SOUNDCLOUD_CLIENT_SECRET = process.env.SOUNDCLOUD_CLIENT_SECRET;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}

if (!SOUNDCLOUD_CLIENT_ID || !SOUNDCLOUD_CLIENT_SECRET) {
  console.error(
    "Missing SOUNDCLOUD_CLIENT_ID or SOUNDCLOUD_CLIENT_SECRET.\n" +
      "Register an app at https://soundcloud.com/you/apps/new (requires an\n" +
      "Artist Pro account) and fill in the credentials in .env.local before running."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// Shared SoundCloud API client (OAuth token + GET wrapper + followings
// pagination) — see scripts/lib/soundcloud.mjs, shared with
// sync-soundcloud.mjs (Phase 2a).
const sc = createSoundcloudClient({ debug: DEBUG });

// Wraps a Supabase call with retry logic for transient network errors
// ("fetch failed", ECONNRESET, ETIMEDOUT). A large enrichment payload can
// drop the connection for 30+ seconds, so we use exponential-ish backoff
// with enough headroom to ride out a real outage.
const SUPABASE_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000]; // ~67s total

function isNetworkError(msg) {
  return (
    msg?.includes("fetch failed") ||
    msg?.includes("ECONNRESET") ||
    msg?.includes("ETIMEDOUT") ||
    msg?.includes("ECONNREFUSED")
  );
}

async function supabaseWithRetry(fn) {
  for (let attempt = 0; attempt <= SUPABASE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await fn();
      if (result.error && attempt < SUPABASE_RETRY_DELAYS_MS.length && isNetworkError(result.error.message)) {
        const delay = SUPABASE_RETRY_DELAYS_MS[attempt];
        if (DEBUG) console.log(`  [debug] supabase network error, retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return result;
    } catch (err) {
      if (attempt < SUPABASE_RETRY_DELAYS_MS.length) {
        const delay = SUPABASE_RETRY_DELAYS_MS[attempt];
        if (DEBUG) console.log(`  [debug] supabase threw, retrying in ${delay}ms: ${err?.message}`);
        await sleep(delay);
        continue;
      }
      return { data: null, error: err };
    }
  }
}

// The SoundCloud OAuth token flow, the authenticated GET wrapper, and
// the followings pagination (getFollowings) now live in
// scripts/lib/soundcloud.mjs, shared with sync-soundcloud.mjs — reached
// through the `sc` client created above (sc.getAccessToken /
// sc.soundcloudGet / sc.resolveUser / sc.getFollowings).

// ------------------------------------------------------------
// Supabase's REST API (PostgREST) caps any single unpaginated query
// at 1000 rows by default — paginate via .range() in pages of 1000,
// same pattern as sync-soundcloud.mjs.
// ------------------------------------------------------------
const SUPABASE_PAGE_SIZE = 1000;

async function fetchAllRows(table, select, applyFilters) {
  const allRows = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from(table)
      .select(select)
      .order(table === "artists" ? "id" : "id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);
    if (applyFilters) query = applyFilters(query);

    const { data, error } = await query;
    if (error) throw error;

    allRows.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }

  return allRows;
}

async function fetchApprovedSoundCloudLinks() {
  return fetchAllRows(
    "artist_links",
    "id, artist_id, url, artists!inner(name, directory_status)",
    (q) => {
      let query = q.eq("platform", "soundcloud").eq("artists.directory_status", "approved").eq("artists.deleted", false);
      if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
      return query;
    }
  );
}

// Looks up a batch of SoundCloud permalink URLs against artist_links and
// returns a map of normalizedUrl -> artist_id for those that already exist.
// Called per-artist rather than loading all 300K+ rows upfront, which
// avoids hitting Supabase's statement timeout as the table grows.
//
// URLs are sent in chunks of 100 to stay well under PostgREST's URL length
// limit. URLs already present in the caller's in-memory map are skipped.
const URL_LOOKUP_CHUNK = 100;

async function lookupSoundCloudUrls(permalinkUrls, existingMap) {
  // Only look up URLs we don't already have in memory.
  const unknown = [...new Set(
    permalinkUrls
      .filter(Boolean)
      .map(cleanScUrl)
      .filter((url) => !existingMap.has(normalizeScUrl(url)))
  )];
  if (unknown.length === 0) return;

  for (let i = 0; i < unknown.length; i += URL_LOOKUP_CHUNK) {
    const chunk = unknown.slice(i, i + URL_LOOKUP_CHUNK);
    const { data, error } = await supabaseWithRetry(() =>
      supabase
        .from("artist_links")
        .select("artist_id, url")
        .eq("platform", "soundcloud")
        .in("url", chunk)
    );
    if (error) {
      if (DEBUG) console.log(`  [debug] URL lookup failed: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) {
      existingMap.set(normalizeScUrl(row.url), row.artist_id);
    }
  }
}

// Returns the set of artist_ids (from the given source artist list) that have
// already been processed (follow_graph_built_at IS NOT NULL) or have a
// recorded error (sync_error IS NOT NULL, e.g. 'resolve_failed').
// Scoped to only the provided IDs so the query stays fast regardless of how
// large artist_enrichment grows (sc_followee enrichment rows are not relevant
// here and can number in the hundreds of thousands).
async function fetchProcessedArtistIds(sourceArtistIds) {
  if (sourceArtistIds.length === 0) return new Set();

  // Send IDs in chunks of 100 to stay under PostgREST's URL length limit
  // (1,353 UUIDs × 36 chars each would be ~50KB in one query string).
  const processed = new Set();
  const CHUNK = 100;

  for (let i = 0; i < sourceArtistIds.length; i += CHUNK) {
    const chunk = sourceArtistIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseWithRetry(() =>
      supabase
        .from("artist_enrichment")
        .select("artist_id")
        .eq("platform", "soundcloud")
        .in("artist_id", chunk)
        .or("follow_graph_built_at.not.is.null,sync_error.not.is.null")
    );
    if (error) throw error;
    for (const row of data ?? []) processed.add(row.artist_id);
  }

  return processed;
}

// normalizeScUrl (in-memory dedupe key) and cleanScUrl (the value
// actually saved to artist_links, tracking params stripped) now live in
// scripts/lib/soundcloud.mjs, shared with sync-soundcloud.mjs.
//
// Source-artist enrichment is no longer written here (as of 2026-07-11):
// sync-soundcloud.mjs (Phase 2a) owns the full SoundCloud pull for
// directory artists — bio, image, links — so this builder re-writing a
// leaner enrichment row for the same approved source artists was pure
// overlap. This script now only touches source artists to fetch their
// followings and to record follow-graph state (follow_graph_built_at /
// sync_error), never their enrichment. Followee enrichment is still
// written below (from the free followings payload) — see main().

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : "Building SoundCloud follow graph\n"
  );
  console.log(
    `Per-artist followings cap: ${FOLLOWINGS_CAP === Infinity ? "unlimited" : FOLLOWINGS_CAP}\n`
  );

  // Fail fast on bad credentials rather than burning through every
  // artist first.
  await sc.getAccessToken();
  console.log("SoundCloud API token acquired.\n");

  if (FORCE) {
    console.log("--force: re-processing all artists, including already-processed ones\n");
  }

  const sourceLinks = await fetchApprovedSoundCloudLinks();
  const sourceArtistIds = sourceLinks.map((r) => r.artist_id);

  const processedArtistIds = FORCE ? new Set() : await fetchProcessedArtistIds(sourceArtistIds);
  const skippedProcessed = FORCE ? 0 : sourceLinks.filter((r) => processedArtistIds.has(r.artist_id)).length;

  let rows = FORCE
    ? sourceLinks
    : sourceLinks.filter((r) => !processedArtistIds.has(r.artist_id));
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(
    `Found ${sourceLinks.length} approved-artist SoundCloud link(s)` +
      (skippedProcessed > 0 ? `, ${skippedProcessed} already processed (skipped)` : "") +
      `${LIMIT ? `, processing next ${rows.length}` : ""}\n`
  );

  // In-memory URL -> artist_id map, populated lazily per source artist
  // (see lookupSoundCloudUrls). Accumulates across the run so accounts
  // followed by more than one source artist are still only created once.
  const scUrlToArtistId = new Map();

  let sourcesProcessed = 0;
  let resolveFailed = 0;
  let followingsFetched = 0;
  let newArtistsCreated = 0;
  let edgesWritten = 0;
  let truncatedCount = 0;
  let enrichmentUpserted = 0;
  let biosWritten = 0;

  for (const row of rows) {
    const sourceName = row.artists?.name ?? row.artist_id;
    const sourceArtistId = row.artist_id;
    const scUrl = row.url;

    sourcesProcessed++;

    const userRes = await sc.resolveUser(scUrl);
    if (!userRes.ok || !userRes.data) {
      resolveFailed++;
      console.log(`✗ ${sourceName}: failed to resolve ${scUrl}`);
      // Record the dead link in the DB so this artist is skipped on future
      // runs. The trigger on artist_links will clear sync_error automatically
      // if the URL is fixed.
      if (!DRY_RUN) {
        await supabaseWithRetry(() =>
          supabase.from("artist_enrichment").upsert(
            {
              artist_id: sourceArtistId,
              platform: "soundcloud",
              sync_error: "resolve_failed",
              last_synced_at: new Date().toISOString(),
            },
            { onConflict: "artist_id,platform" }
          )
        );
      }
      await sleep(300);
      continue;
    }

    const urn = userRes.data.urn ?? (userRes.data.id != null ? `soundcloud:users:${userRes.data.id}` : null);
    if (!urn) {
      console.log(`✗ ${sourceName}: resolved user has no urn, skipping`);
      await sleep(300);
      continue;
    }

    // Source-artist enrichment is intentionally NOT written here anymore
    // — sync-soundcloud.mjs (Phase 2a) owns the full SoundCloud pull for
    // directory artists (bio + image + links). This builder only needs
    // the resolved user for its urn (to fetch followings) and marks
    // follow-graph state at the end of the loop.

    const { ok, users, truncated } = await sc.getFollowings(urn, FOLLOWINGS_CAP);
    if (!ok) {
      resolveFailed++;
      console.log(`✗ ${sourceName}: failed to fetch followings`);
      await sleep(300);
      continue;
    }
    if (truncated) truncatedCount++;

    followingsFetched += users.length;

    // Populate the in-memory map for any of this artist's followings that
    // are already in the DB but not yet seen this run.
    await lookupSoundCloudUrls(
      users.map((u) => u.permalink_url),
      scUrlToArtistId
    );

    let artistsCreatedForThisSource = 0;

    // ---- Pass 1: classify each followed account as known or new ----------
    // toCreate  — new accounts not yet in the DB, in followings order
    // followedMeta — all valid followed accounts, in followings order
    //               (used for edge-pair construction in pass 3)
    const toCreate = [];   // { followed, normalized, name }
    const followedMeta = []; // { followed, normalized }

    for (const followed of users) {
      const permalinkUrl = followed.permalink_url;
      if (!permalinkUrl) continue;

      const normalized = normalizeScUrl(permalinkUrl);
      followedMeta.push({ followed, normalized });

      if (!scUrlToArtistId.has(normalized)) {
        // The `name` is the artist's SoundCloud display name = `username` (the
        // large name on the profile). `full_name` is a separate optional field
        // (often a real/legal name or junk shown beneath it) and is deliberately
        // NOT used here — capturing it was the earlier bug that
        // scripts/backfill-sc-followee-names.mjs repairs. The "Unknown …" default
        // only guards the (essentially nonexistent) blank-username case, since
        // artists.name is NOT NULL.
        const name =
          cleanArtistName(typeof followed.username === "string" ? followed.username : "") ||
          "Unknown SoundCloud artist";

        if (DEBUG) console.log(`  [debug] new artist: ${name} (${permalinkUrl})`);
        toCreate.push({ followed, normalized, name });
      }
    }

    // ---- Pass 2: batch-insert new artists in chunks of 50 ---------------
    // Chunking keeps individual request payloads small. The raw SoundCloud
    // payloads go to api_response_cache (namespace 'soundcloud_user')
    // rather than artist_enrichment.raw_data, so it's the cache upsert
    // below that carries a full JSONB blob per row — 50+ blobs in one
    // request can push hundreds of KB and drop the Supabase connection, so
    // it's chunked alongside the artist/link/enrichment/bio inserts.
    // PostgreSQL returns INSERT rows in insertion order within each chunk,
    // so index i of insertedArtists maps to chunk[i].
    const DB_CHUNK_SIZE = 50;

    if (toCreate.length > 0) {
      if (!DRY_RUN) {
        for (let chunkStart = 0; chunkStart < toCreate.length; chunkStart += DB_CHUNK_SIZE) {
          const chunk = toCreate.slice(chunkStart, chunkStart + DB_CHUNK_SIZE);

          const { data: insertedArtists, error: insertArtistsError } = await supabaseWithRetry(() =>
            supabase
              .from("artists")
              .insert(chunk.map((a) => ({ name: a.name, directory_status: "sc_followee" })))
              .select("id")
          );

          if (insertArtistsError) {
            console.error(`  failed to batch-create artists (chunk ${chunkStart}–${chunkStart + chunk.length - 1}): ${insertArtistsError.message}`);
            // Skip links + enrichments for this chunk; edges for these artists
            // won't be written but the source artist still gets cached.
            continue;
          }

          const newLinks = [];
          const newEnrichments = [];
          const newBios = [];
          const newCacheRows = [];

          for (let i = 0; i < chunk.length; i++) {
            const { followed, normalized } = chunk[i];
            const artistId = insertedArtists[i].id;
            scUrlToArtistId.set(normalized, artistId);
            artistsCreatedForThisSource++;

            newLinks.push({
              artist_id: artistId,
              platform: "soundcloud",
              handle: followed.username ?? null,
              url: cleanScUrl(followed.permalink_url),
            });

            // Followee enrichment is deliberately minimal (as of 2026-07-11):
            // for a non-directory follow-graph node all we keep is
            // follower_count — enough to weed out non-artist / low-signal
            // accounts — plus external_id for identity. No image (images are
            // directory-only), no track_count (unused for these nodes). The
            // bio goes to the biographies table instead (see newBios below).
            newEnrichments.push({
              artist_id: artistId,
              platform: "soundcloud",
              external_id: followed.id != null ? String(followed.id) : null,
              follower_count: followed.followers_count ?? null,
              last_synced_at: new Date().toISOString(),
              sync_error: null,
            });

            // Followee bio → biographies (platform='soundcloud'), same home
            // as directory-artist / Discogs / Linktree bios. Kept for
            // deduplication: comparing a followee's bio against bios from
            // other sources (e.g. sync-hoer imports, which often arrive with
            // no other platform links) helps match the same artist across
            // sources when their names are spelled slightly differently. Raw
            // description as-is — no cleanup pipeline here.
            const followeeBio =
              typeof followed.description === "string" && followed.description.trim()
                ? followed.description.trim()
                : null;
            if (followeeBio) {
              newBios.push({
                artist_id: artistId,
                platform: "soundcloud",
                bio: followeeBio,
                source_url: cleanScUrl(followed.permalink_url),
              });
            }

            // Raw payload → api_response_cache (namespace 'soundcloud_user',
            // cache_key = artist_id), replacing artist_enrichment.raw_data.
            newCacheRows.push({
              namespace: "soundcloud_user",
              cache_key: String(artistId),
              payload: followed,
              fetched_at: new Date().toISOString(),
            });
          }

          const { error: linksError } = await supabaseWithRetry(() =>
            supabase.from("artist_links").insert(newLinks)
          );
          if (linksError) {
            console.error(`  failed to batch-insert artist links (chunk ${chunkStart}): ${linksError.message}`);
          }

          const { error: enrichError } = await supabaseWithRetry(() =>
            supabase
              .from("artist_enrichment")
              .upsert(newEnrichments, { onConflict: "artist_id,platform" })
          );
          if (enrichError) {
            console.error(`  failed to batch-upsert enrichments (chunk ${chunkStart}): ${enrichError.message}`);
          } else {
            enrichmentUpserted += newEnrichments.length;
          }

          // Followee bios → biographies (best-effort; a followee with no
          // description contributes no row). Non-fatal like the cache write:
          // the recommender/edges don't depend on it, and the bio is
          // re-derivable from the cached raw payload.
          if (newBios.length > 0) {
            const { error: bioError } = await supabaseWithRetry(() =>
              supabase
                .from("biographies")
                .upsert(newBios, { onConflict: "artist_id,platform" })
            );
            if (bioError) {
              console.error(`  failed to batch-upsert followee bios (chunk ${chunkStart}, non-fatal): ${bioError.message}`);
            } else {
              biosWritten += newBios.length;
            }
          }

          // Raw payloads → api_response_cache (best-effort archival; the blob
          // is re-fetchable, so a failure here doesn't block edge-building).
          const { error: cacheError } = await supabaseWithRetry(() =>
            supabase
              .from("api_response_cache")
              .upsert(newCacheRows, { onConflict: "namespace,cache_key" })
          );
          if (cacheError) {
            console.error(`  failed to batch-cache raw_data (chunk ${chunkStart}, non-fatal): ${cacheError.message}`);
          }
        }
      } else {
        // DRY_RUN: synthesize placeholder ids so edge-counting still works.
        for (const { normalized } of toCreate) {
          scUrlToArtistId.set(normalized, `dry-run:${normalized}`);
          artistsCreatedForThisSource++;
        }
      }

      newArtistsCreated += artistsCreatedForThisSource;
    }

    // ---- Pass 3: build edge pairs from the now-complete id map -----------
    const edgePairs = [];
    for (const { normalized } of followedMeta) {
      const followedArtistId = scUrlToArtistId.get(normalized);
      if (!followedArtistId) continue; // batch insert failed for this artist
      if (followedArtistId === sourceArtistId) continue; // chk_sc_follow_no_self
      edgePairs.push({
        follower_artist_id: sourceArtistId,
        followed_artist_id: followedArtistId,
      });
    }

    if (edgePairs.length > 0 && !DRY_RUN) {
      const realPairs = edgePairs.filter(
        (e) => typeof e.followed_artist_id === "string" && !e.followed_artist_id.startsWith("dry-run:")
      );
      const { error: edgeError } = await supabaseWithRetry(() =>
        supabase
          .from("sc_follow_edges")
          .upsert(realPairs, {
            onConflict: "follower_artist_id,followed_artist_id",
            ignoreDuplicates: true,
          })
      );
      if (edgeError) {
        console.error(`  failed to write follow edges for ${sourceName}: ${edgeError.message}`);
      } else {
        edgesWritten += realPairs.length;
      }
    } else if (DRY_RUN) {
      edgesWritten += edgePairs.length;
    }

    console.log(
      `${truncated ? "~" : "✓"} ${sourceName}: ${users.length} following(s)` +
        (truncated ? " (capped, more remain)" : "") +
        `, ${artistsCreatedForThisSource} new artist(s), ${edgePairs.length} edge(s)`
    );

    // Mark this source artist as done so they are skipped on future runs.
    if (!DRY_RUN) {
      const { error: markDoneError } = await supabaseWithRetry(() =>
        supabase.from("artist_enrichment").upsert(
          {
            artist_id: sourceArtistId,
            platform: "soundcloud",
            follow_graph_built_at: new Date().toISOString(),
          },
          { onConflict: "artist_id,platform" }
        )
      );
      if (markDoneError) {
        console.error(`  failed to mark follow graph as built for ${sourceName}: ${markDoneError.message}`);
      }
    }

    await sleep(300);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  source artists processed: ${sourcesProcessed}`);
  console.log(`  skipped (done/error):     ${skippedProcessed}`);
  console.log(`  resolve/fetch failed:     ${resolveFailed}`);
  console.log(`  followings fetched:       ${followingsFetched}`);
  console.log(`  capped (more remain):     ${truncatedCount}`);
  console.log(`  new artists created:      ${newArtistsCreated}`);
  console.log(`  follow edges ${DRY_RUN ? "(would be) written" : "written"}:    ${edgesWritten}`);
  console.log(`  followee enrichment:      ${DRY_RUN ? "(dry run — no writes)" : enrichmentUpserted}`);
  console.log(`  followee bios:            ${DRY_RUN ? "(dry run — no writes)" : biosWritten}`);
}

main().catch((err) => {
  console.error("\nFollow-graph build failed:", err?.message ?? err);
  process.exit(1);
});
