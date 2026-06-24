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
// For every artist touched — both source directory artists (via the
// /resolve call) and newly-discovered followed artists (from the
// followings collection) — the full SoundCloud user object is already
// returned by the API at no extra cost and is written to
// `artist_enrichment`: follower_count, track_count, bio, avatar URL
// (upgraded to 500×500), plus the raw user object as JSONB for future
// re-processing. Already-existing followed artists are not re-enriched
// here; a dedicated enrichment pipeline handles those.
//
// Uses the OFFICIAL SoundCloud API (api.soundcloud.com), same OAuth
// Client Credentials flow as harvest-soundcloud-links-and-bio.mjs.
// Requires SoundCloud API credentials (Client ID + Secret), which
// requires a SoundCloud account on the Artist Pro plan:
//   1. https://soundcloud.com/you/apps/new (while signed in)
//   2. Copy the Client ID / Client Secret into .env.local as
//      SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET
// (also requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, as
// with the other scripts in this folder.)
//
// Usage (from the wem-directory/ folder):
//
//   node scripts/build-soundcloud-follow-graph.mjs                  # all approved artists with a SoundCloud link
//   node scripts/build-soundcloud-follow-graph.mjs --limit=5        # only the next 5 unprocessed source artists (for testing)
//   node scripts/build-soundcloud-follow-graph.mjs --force          # re-pull even source artists already processed (bypasses cache)
//   node scripts/build-soundcloud-follow-graph.mjs --debug          # log every followed account considered
//   node scripts/build-soundcloud-follow-graph.mjs --max-followings=200
//                                                                    # cap how many followings are pulled per source artist (default 500; 0 = unlimited)
//   node scripts/build-soundcloud-follow-graph.mjs --name=jeanne    # only source artists whose name matches (testing a single artist)
//   DRY_RUN=1 node scripts/build-soundcloud-follow-graph.mjs        # fetch + log, don't write to the DB
//
// Start with --limit (and/or --name) on a small batch before running
// the full ~1,400 — a single popular artist's followings list can run
// into the hundreds of API calls once you add pagination, and every
// previously-unseen followed account becomes a new row in `artists`.
//
// Results are cached in build-soundcloud-follow-graph-cache.json
// alongside this script (which source artists' followings have
// already been pulled) so re-running without --force only processes
// new/unprocessed source artists.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanArtistName } from "./lib/name-utils.mjs";

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
// Source-artist-level cache — persisted to disk between runs.
// Structure: { [soundcloudUrl]: { checkedAt: ISO string, followingsFetched: number, newArtistsCreated: number, edgesWritten: number } }
// A source artist's SoundCloud URL present in the cache is not
// re-processed unless --force is passed.
// ------------------------------------------------------------
const CACHE_PATH = path.join(__dirname, "build-soundcloud-follow-graph-cache.json");

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    }
  } catch (err) {
    console.warn(`Warning: could not read cache file (${err.message}); starting fresh.`);
  }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.warn(`Warning: could not write cache file (${err.message}).`);
  }
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wraps a Supabase call with retry logic for transient network errors
// ("fetch failed", ECONNRESET, ETIMEDOUT). The PostgREST connection pool
// can get overwhelmed during bulk inserts; backing off and retrying is
// sufficient to recover in almost all cases.
async function supabaseWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();
      if (
        result.error &&
        attempt < maxRetries - 1 &&
        (result.error.message?.includes("fetch failed") ||
          result.error.message?.includes("ECONNRESET") ||
          result.error.message?.includes("ETIMEDOUT"))
      ) {
        if (DEBUG) console.log(`  [debug] supabase network error, retrying in ${(attempt + 1) * 1000}ms`);
        await sleep((attempt + 1) * 1000);
        continue;
      }
      return result;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        if (DEBUG) console.log(`  [debug] supabase threw, retrying in ${(attempt + 1) * 1000}ms: ${err?.message}`);
        await sleep((attempt + 1) * 1000);
        continue;
      }
      return { data: null, error: err };
    }
  }
}

// ------------------------------------------------------------
// SoundCloud OAuth (Client Credentials flow — app-only, public
// resources). One token is fetched and reused for the whole run;
// it's refreshed if a request comes back 401. Mirrors
// harvest-soundcloud-links-and-bio.mjs.
// ------------------------------------------------------------
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(`${SOUNDCLOUD_CLIENT_ID}:${SOUNDCLOUD_CLIENT_SECRET}`).toString(
    "base64"
  );

  const res = await fetch("https://secure.soundcloud.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json; charset=utf-8",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to get SoundCloud access token (HTTP ${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

// ------------------------------------------------------------
// Authenticated GET against the SoundCloud API. Accepts either a
// path+query (prefixed with api.soundcloud.com) or a full URL (used
// for `next_href` pagination cursors, which SoundCloud returns as
// complete URLs already pointing at api.soundcloud.com). Retries
// once on 401 (refreshes the token) and once on 429 (backs off, then
// retries) — same behavior as harvest-soundcloud-links-and-bio.mjs.
// ------------------------------------------------------------
async function soundcloudGet(pathQueryOrUrl, { retry = true } = {}) {
  const token = await getAccessToken();
  const url = pathQueryOrUrl.startsWith("http")
    ? pathQueryOrUrl
    : `https://api.soundcloud.com${pathQueryOrUrl}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json; charset=utf-8",
        Authorization: `OAuth ${token}`,
      },
    });

    if (res.status === 401 && retry) {
      await getAccessToken(true);
      return soundcloudGet(pathQueryOrUrl, { retry: false });
    }

    if (res.status === 429) {
      if (DEBUG) console.log("  [debug] 429 rate limited, backing off 5s");
      await sleep(5000);
      if (retry) return soundcloudGet(pathQueryOrUrl, { retry: false });
      return { ok: false, status: 429, data: null };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }

    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    if (DEBUG) console.log(`  [debug] request failed: ${err?.message ?? err}`);
    return { ok: false, status: null, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveUser(scUrl) {
  return soundcloudGet(`/resolve?url=${encodeURIComponent(scUrl)}`);
}

// ------------------------------------------------------------
// Fetch up to `cap` followings for a user, following the API's
// linked_partitioning `next_href` cursor until exhausted or the cap
// is hit. Returns { ok, users, truncated }.
// ------------------------------------------------------------
async function getFollowings(urn, cap) {
  const users = [];
  let nextUrl = `/users/${encodeURIComponent(urn)}/followings?limit=200&linked_partitioning=true`;
  let truncated = false;

  while (nextUrl && users.length < cap) {
    const res = await soundcloudGet(nextUrl);
    if (!res.ok || !res.data) {
      return { ok: users.length > 0, users, truncated: false, lastStatus: res.status };
    }

    const page = Array.isArray(res.data.collection) ? res.data.collection : [];
    for (const u of page) {
      users.push(u);
      if (users.length >= cap) {
        truncated = Boolean(res.data.next_href);
        break;
      }
    }

    nextUrl = users.length < cap ? res.data.next_href ?? null : null;
    if (nextUrl) await sleep(200);
  }

  return { ok: true, users, truncated, lastStatus: 200 };
}

// ------------------------------------------------------------
// Supabase's REST API (PostgREST) caps any single unpaginated query
// at 1000 rows by default — paginate via .range() in pages of 1000,
// same pattern as harvest-soundcloud-links-and-bio.mjs.
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
      let query = q.eq("platform", "soundcloud").eq("artists.directory_status", "approved");
      if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
      return query;
    }
  );
}

// Map of every known SoundCloud profile URL -> artist_id, so newly
// followed accounts can be matched against artists that already
// exist (directory members or previously-discovered graph nodes)
// instead of being duplicated.
async function fetchAllSoundCloudUrlMap() {
  const rows = await fetchAllRows("artist_links", "artist_id, url", (q) =>
    q.eq("platform", "soundcloud")
  );
  const map = new Map();
  for (const row of rows) map.set(normalizeScUrl(row.url), row.artist_id);
  return map;
}

function normalizeScUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString().toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

// Strips tracking query strings/fragments from a SoundCloud profile URL
// before it's written to artist_links, e.g.
//   https://soundcloud.com/damacha?utm_medium=api&utm_campaign=social_sharing&utm_source=id_332561
//   -> https://soundcloud.com/damacha
// Unlike normalizeScUrl (used only for in-memory dedupe-key matching),
// this preserves the original case/trailing slash exactly as SoundCloud
// returned it, since this is the value that actually gets saved.
function cleanScUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

// SoundCloud CDN avatar URLs default to a 100×100 "-large" variant.
// Replacing the suffix with "-t500x500" gets the 500×500 version,
// which is the largest size the CDN serves without a separate request.
function upgradeAvatarUrl(url) {
  if (typeof url !== "string" || !url) return null;
  return url.replace(/-large(\.\w+)$/, "-t500x500$1").replace(/-large$/, "-t500x500");
}

// Upsert enrichment data from a SoundCloud user object into
// artist_enrichment. Called for both source artists (from /resolve)
// and newly-created followed artists (from the followings collection)
// — the data is already in hand from those API responses, so no
// extra API calls are needed.
async function upsertEnrichment(artistId, user) {
  if (DRY_RUN) return { error: null };

  return supabaseWithRetry(() => supabase.from("artist_enrichment").upsert(
    {
      artist_id: artistId,
      platform: "soundcloud",
      external_id: user.id != null ? String(user.id) : null,
      profile_image_url: upgradeAvatarUrl(user.avatar_url),
      bio: typeof user.description === "string" && user.description.trim()
        ? user.description.trim()
        : null,
      follower_count: user.followers_count ?? null,
      track_count: user.track_count ?? null,
      recent_tracks: null, // tracks not fetched in this script
      raw_data: user,
      last_synced_at: new Date().toISOString(),
      sync_error: null,
    },
    { onConflict: "artist_id,platform" }
  ));
}

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
  await getAccessToken();
  console.log("SoundCloud API token acquired.\n");

  const cache = FORCE ? {} : loadCache();
  if (FORCE) {
    console.log("--force: bypassing source-artist cache\n");
  } else {
    const cachedCount = Object.keys(cache).length;
    if (cachedCount > 0) {
      console.log(
        `Cache loaded: ${cachedCount} source artist(s) already processed (pass --force to bypass)\n`
      );
    }
  }

  const sourceLinks = await fetchApprovedSoundCloudLinks();

  let rows = sourceLinks;
  let skippedCached = 0;
  if (!FORCE) {
    const remaining = [];
    for (const row of sourceLinks) {
      if (cache[row.url] !== undefined) {
        skippedCached++;
      } else {
        remaining.push(row);
      }
    }
    rows = remaining;
  }
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(
    `Found ${sourceLinks.length} approved-artist SoundCloud link(s)` +
      (skippedCached > 0 ? `, ${skippedCached} already cached (skipped)` : "") +
      `${LIMIT ? `, processing next ${rows.length}` : ""}\n`
  );

  // Loaded once up front; updated in-memory as new artists are
  // created during this run so accounts followed by more than one
  // source artist in the same run are still only created once.
  const scUrlToArtistId = await fetchAllSoundCloudUrlMap();

  let sourcesProcessed = 0;
  let resolveFailed = 0;
  let followingsFetched = 0;
  let newArtistsCreated = 0;
  let edgesWritten = 0;
  let truncatedCount = 0;
  let enrichmentUpserted = 0;

  for (const row of rows) {
    const sourceName = row.artists?.name ?? row.artist_id;
    const sourceArtistId = row.artist_id;
    const scUrl = row.url;

    sourcesProcessed++;

    const userRes = await resolveUser(scUrl);
    if (!userRes.ok || !userRes.data) {
      resolveFailed++;
      console.log(`✗ ${sourceName}: failed to resolve ${scUrl}`);
      cache[scUrl] = {
        checkedAt: new Date().toISOString(),
        followingsFetched: 0,
        newArtistsCreated: 0,
        edgesWritten: 0,
        error: "resolve_failed",
      };
      if (!DRY_RUN) saveCache(cache);
      await sleep(300);
      continue;
    }

    const urn = userRes.data.urn ?? (userRes.data.id != null ? `soundcloud:users:${userRes.data.id}` : null);
    if (!urn) {
      console.log(`✗ ${sourceName}: resolved user has no urn, skipping`);
      await sleep(300);
      continue;
    }

    // The resolve response already contains the full user object for the
    // source artist — upsert their enrichment at no extra API cost.
    const { error: sourceEnrichError } = await upsertEnrichment(sourceArtistId, userRes.data);
    if (sourceEnrichError) {
      console.error(`  failed to upsert enrichment for ${sourceName}: ${sourceEnrichError.message}`);
    } else {
      enrichmentUpserted++;
    }

    const { ok, users, truncated } = await getFollowings(urn, FOLLOWINGS_CAP);
    if (!ok) {
      resolveFailed++;
      console.log(`✗ ${sourceName}: failed to fetch followings`);
      await sleep(300);
      continue;
    }
    if (truncated) truncatedCount++;

    followingsFetched += users.length;

    let artistsCreatedForThisSource = 0;
    const edgePairs = [];

    for (const followed of users) {
      const permalinkUrl = followed.permalink_url;
      if (!permalinkUrl) continue;

      const normalized = normalizeScUrl(permalinkUrl);
      let followedArtistId = scUrlToArtistId.get(normalized);

      if (!followedArtistId) {
        const name =
          cleanArtistName(typeof followed.full_name === "string" ? followed.full_name : "") ||
          cleanArtistName(typeof followed.username === "string" ? followed.username : "") ||
          "Unknown SoundCloud artist";

        if (DEBUG) console.log(`  [debug] new artist: ${name} (${permalinkUrl})`);

        if (!DRY_RUN) {
          const { data: inserted, error: insertArtistError } = await supabaseWithRetry(() =>
            supabase
              .from("artists")
              .insert({ name, directory_status: "sc_followee" })
              .select("id")
              .single()
          );

          if (insertArtistError) {
            console.error(`  failed to create artist for ${name}: ${insertArtistError.message}`);
            continue;
          }

          followedArtistId = inserted.id;
          await sleep(50);

          const { error: insertLinkError } = await supabaseWithRetry(() =>
            supabase.from("artist_links").insert({
              artist_id: followedArtistId,
              platform: "soundcloud",
              handle: followed.username ?? null,
              url: cleanScUrl(permalinkUrl),
            })
          );
          if (insertLinkError) {
            console.error(`  failed to save soundcloud link for ${name}: ${insertLinkError.message}`);
          }
          await sleep(50);

          // The followings response already contains the full user object
          // — upsert enrichment for this new artist at no extra API cost.
          const { error: enrichError } = await upsertEnrichment(followedArtistId, followed);
          if (enrichError) {
            console.error(`  failed to save enrichment for ${name}: ${enrichError.message}`);
          } else {
            enrichmentUpserted++;
          }
        } else {
          // DRY_RUN: synthesize a placeholder id so edge-counting logic
          // below still runs, but nothing is ever written.
          followedArtistId = `dry-run:${normalized}`;
        }

        scUrlToArtistId.set(normalized, followedArtistId);
        newArtistsCreated++;
        artistsCreatedForThisSource++;
      }

      if (followedArtistId === sourceArtistId) continue; // chk_sc_follow_no_self
      edgePairs.push({
        follower_artist_id: sourceArtistId,
        followed_artist_id: followedArtistId,
      });
    }

    if (edgePairs.length > 0 && !DRY_RUN) {
      // Filter out any placeholder ids (shouldn't happen outside
      // DRY_RUN, but guards against a partial insert failure above).
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

    cache[scUrl] = {
      checkedAt: new Date().toISOString(),
      followingsFetched: users.length,
      newArtistsCreated: artistsCreatedForThisSource,
      edgesWritten: edgePairs.length,
      truncated,
    };
    if (!DRY_RUN) saveCache(cache);

    await sleep(300);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  source artists processed: ${sourcesProcessed}`);
  console.log(`  skipped (cached):         ${skippedCached}`);
  console.log(`  resolve/fetch failed:     ${resolveFailed}`);
  console.log(`  followings fetched:       ${followingsFetched}`);
  console.log(`  capped (more remain):     ${truncatedCount}`);
  console.log(`  new artists created:      ${newArtistsCreated}`);
  console.log(`  follow edges ${DRY_RUN ? "(would be) written" : "written"}:    ${edgesWritten}`);
  console.log(`  enrichment upserted:      ${DRY_RUN ? "(dry run — no writes)" : enrichmentUpserted}`);
}

main().catch((err) => {
  console.error("\nFollow-graph build failed:", err?.message ?? err);
  process.exit(1);
});
