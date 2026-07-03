#!/usr/bin/env node
// ============================================================
// SoundCloud enrichment: resolves every artist that has a SoundCloud
// link and upserts their profile data into `artist_enrichment`.
//
// For each artist with a `soundcloud` row in artist_links, this
// script calls GET /resolve?url=<profile url> via the official
// SoundCloud API and writes the following to artist_enrichment:
//
//   - follower_count    (followers_count from the API response)
//   - track_count       (track_count)
//   - bio               (description, trimmed)
//   - profile_image_url (avatar_url, upgraded from -large to -t500x500)
//   - external_id       (SoundCloud numeric user ID, as a string)
//   - playlists         (only fetched when track_count is 0 — see below)
//   - raw_data          (full user object as JSONB)
//   - last_synced_at    (timestamp of this run)
//
// When track_count is 0 (account has no uploads of its own — often
// because everything is a repost from another account, e.g. a podcast),
// this script additionally calls GET /users/{id}/playlists and stores
// every public playlist found as [{ title, url, track_count }]. The
// public API has no endpoint for a user's reposts, so playlists are
// the best available fallback content for the artist page's widget.
//
// Uses an upsert on (artist_id, platform) so re-running refreshes
// existing rows rather than creating duplicates. Artists without an
// existing artist_enrichment row for soundcloud get one created.
//
// Requires SoundCloud API credentials (Artist Pro + registered app):
//   SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET in .env.local
//   (also NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY)
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/enrich-soundcloud.mjs                    # all artists with a SoundCloud link
//   node scripts/enrich-soundcloud.mjs --limit=20         # next 20 unprocessed (for testing)
//   node scripts/enrich-soundcloud.mjs --force            # re-fetch even cached artists
//   node scripts/enrich-soundcloud.mjs --name=jeanne      # filter source artists by name
//   node scripts/enrich-soundcloud.mjs --status=sc_followee
//                                                          # only artists with this directory_status
//   node scripts/enrich-soundcloud.mjs --debug            # log raw API responses
//   DRY_RUN=1 node scripts/enrich-soundcloud.mjs          # fetch + log, no DB writes
//
// Results are cached in enrich-soundcloud-cache.json alongside this
// script so re-runs skip already-processed artists (pass --force to
// bypass). --limit counts from the remaining unprocessed artists, not
// from the full list, so repeated --limit runs make forward progress.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinktree } from "./lib/linktree.mjs";
import { decodeEntities, isGenericDescription, parseDescription, decodeGateSc } from "./lib/soundcloud-bio.mjs";

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
const statusArg = args.find((a) => a.startsWith("--status="));
const STATUS_FILTER = statusArg ? statusArg.slice("--status=".length) : null;

// ------------------------------------------------------------
// Cache — persisted to disk between runs.
// Structure: { [soundcloudUrl]: { checkedAt: ISO string, ok: boolean } }
// ------------------------------------------------------------
const CACHE_PATH = path.join(__dirname, "enrich-soundcloud-cache.json");

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

// ------------------------------------------------------------
// SoundCloud OAuth (Client Credentials — app-only, public resources).
// One token is fetched and reused for the whole run; refreshed on 401.
// ------------------------------------------------------------
let cachedToken = null;

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

async function soundcloudGet(pathAndQuery, { retry = true } = {}) {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`https://api.soundcloud.com${pathAndQuery}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json; charset=utf-8",
        Authorization: `OAuth ${token}`,
      },
    });

    if (res.status === 401 && retry) {
      await getAccessToken(true);
      return soundcloudGet(pathAndQuery, { retry: false });
    }

    if (res.status === 429) {
      if (DEBUG) console.log("  [debug] 429 rate limited, backing off 5s");
      await sleep(5000);
      if (retry) return soundcloudGet(pathAndQuery, { retry: false });
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

// ------------------------------------------------------------
// SoundCloud CDN avatar URLs default to a 100×100 "-large" variant.
// Replacing the suffix with "-t500x500" gets the 500×500 version.
// ------------------------------------------------------------
function upgradeAvatarUrl(url) {
  if (typeof url !== "string" || !url) return null;
  return url.replace(/-large(\.\w+)$/, "-t500x500$1").replace(/-large$/, "-t500x500");
}

// ------------------------------------------------------------
// Supabase pagination — PostgREST caps unpaginated queries at 1000
// rows; fetch in pages until a short page signals the end.
// ------------------------------------------------------------
const SUPABASE_PAGE_SIZE = 1000;

async function fetchAllSoundCloudLinks() {
  const allRows = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("artist_links")
      .select("id, artist_id, url, artists!inner(name, directory_status)")
      .eq("platform", "soundcloud")
      .order("id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);

    if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
    if (STATUS_FILTER) query = query.eq("artists.directory_status", STATUS_FILTER);

    const { data, error } = await query;
    if (error) throw error;

    allRows.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }

  return allRows;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running SoundCloud enrichment\n"
  );
  if (STATUS_FILTER) console.log(`Filtering by directory_status: ${STATUS_FILTER}\n`);

  await getAccessToken();
  console.log("SoundCloud API token acquired.\n");

  const cache = FORCE ? {} : loadCache();
  if (FORCE) {
    console.log("--force: bypassing cache\n");
  } else {
    const cachedCount = Object.keys(cache).length;
    if (cachedCount > 0) {
      console.log(
        `Cache loaded: ${cachedCount} URL(s) already processed (pass --force to bypass)\n`
      );
    }
  }

  const links = await fetchAllSoundCloudLinks();

  let rows = links;
  let skippedCached = 0;
  if (!FORCE) {
    const remaining = [];
    for (const row of links) {
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
    `Found ${links.length} SoundCloud link(s)` +
      (skippedCached > 0 ? `, ${skippedCached} already cached (skipped)` : "") +
      `${LIMIT ? `, processing next ${rows.length}` : ""}\n`
  );

  let processed = 0;
  let failed = 0;
  let upserted = 0;

  for (const row of rows) {
    const name = row.artists?.name ?? row.artist_id;
    const scUrl = row.url;

    processed++;

    const res = await soundcloudGet(`/resolve?url=${encodeURIComponent(scUrl)}`);

    if (!res.ok || !res.data) {
      failed++;
      console.log(`✗ ${name}: resolve failed (HTTP ${res.status ?? "timeout"})`);
      cache[scUrl] = { checkedAt: new Date().toISOString(), ok: false };
      if (!DRY_RUN) saveCache(cache);
      await sleep(300);
      continue;
    }

    const user = res.data;

    if (DEBUG) {
      console.log(
        `  [debug] ${name}: followers=${user.followers_count} tracks=${user.track_count} ` +
          `avatar=${user.avatar_url ?? "(none)"}`
      );
    }

    // -- Zero uploads: fall back to the account's playlists (sets) --
    // There's no public API endpoint for a user's reposts, so this is
    // the best available substitute for "what can we embed for them."
    let playlists = null;
    if (user.track_count === 0 && user.id != null) {
      const playlistsRes = await soundcloudGet(
        `/users/${user.id}/playlists?limit=200&linked_partitioning=1`
      );
      if (playlistsRes.ok && Array.isArray(playlistsRes.data?.collection ?? playlistsRes.data)) {
        const raw = playlistsRes.data.collection ?? playlistsRes.data;
        playlists = raw
          .filter((p) => p?.permalink_url)
          .map((p) => ({
            title: p.title ?? "Untitled playlist",
            url: p.permalink_url,
            track_count: p.track_count ?? 0,
          }));
        if (DEBUG) {
          console.log(`  [debug] ${name}: 0 tracks, found ${playlists.length} playlist(s)`);
        }
      } else if (DEBUG) {
        console.log(`  [debug] ${name}: playlists fetch failed (HTTP ${playlistsRes.status ?? "timeout"})`);
      }
      await sleep(300);
    }

    // -- Process the bio through the same pipeline as enrich-bios.mjs --
    // decodeEntities → boilerplate check → decodeGateSc → extractLinktree
    // → parseDescription. This splits the raw description into a clean bio
    // plus any booking/management/contact info and Linktree URL, which are
    // stored separately on the artists table (same as enrich-bios does).
    let bio = null;
    let booking = null;
    let management = null;
    let contact = null;
    let linktreeUrl = null;

    const rawDescription =
      typeof user.description === "string" ? user.description.trim() : null;

    if (rawDescription && !isGenericDescription(rawDescription)) {
      const decoded = decodeEntities(rawDescription);
      const decodedGateSc = decodeGateSc(decoded);
      const { text: withoutLinktree, linktreeUrl: lt } = extractLinktree(decodedGateSc);
      linktreeUrl = lt;
      const parsed = parseDescription(withoutLinktree);
      bio = parsed.bio;
      booking = parsed.booking;
      management = parsed.management;
      contact = parsed.contact;
    }

    if (!DRY_RUN) {
      const { error } = await supabase.from("artist_enrichment").upsert(
        {
          artist_id: row.artist_id,
          platform: "soundcloud",
          external_id: user.id != null ? String(user.id) : null,
          profile_image_url: upgradeAvatarUrl(user.avatar_url),
          bio: bio ? `SoundCloud bio: ${bio}` : bio,
          follower_count: user.followers_count ?? null,
          track_count: user.track_count ?? null,
          recent_tracks: null,
          playlists,
          raw_data: user,
          last_synced_at: new Date().toISOString(),
          sync_error: null,
        },
        { onConflict: "artist_id,platform" }
      );

      if (error) {
        failed++;
        console.log(`✗ ${name}: upsert failed — ${error.message}`);
        cache[scUrl] = { checkedAt: new Date().toISOString(), ok: false, error: error.message };
        saveCache(cache);
        await sleep(300);
        continue;
      }

      // Write booking/management/contact/linktree to the artists table,
      // same as enrich-bios does — only updating fields that were found.
      if (booking || management || contact || linktreeUrl) {
        const update = {};
        if (booking) update.booking_info = booking;
        if (management) update.management_info = management;
        if (contact) update.contact_info = contact;
        if (linktreeUrl) update.linktree_url = linktreeUrl;
        const { error: artistUpdateError } = await supabase
          .from("artists")
          .update(update)
          .eq("id", row.artist_id);
        if (artistUpdateError) {
          console.error(`  failed to save booking/management/contact/linktree: ${artistUpdateError.message}`);
        }
      }

      upserted++;
    } else {
      upserted++;
    }

    const followers = user.followers_count != null ? user.followers_count.toLocaleString() : "?";
    const playlistsNote = playlists ? `, ${playlists.length} playlist(s) as fallback` : "";
    console.log(`✓ ${name}: ${followers} followers, ${user.track_count ?? "?"} tracks${playlistsNote}`);

    cache[scUrl] = { checkedAt: new Date().toISOString(), ok: true };
    if (!DRY_RUN) saveCache(cache);

    await sleep(300);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  processed:        ${processed}`);
  console.log(`  skipped (cached): ${skippedCached}`);
  console.log(`  failed:           ${failed}`);
  console.log(`  ${DRY_RUN ? "would upsert" : "upserted"}:        ${upserted}`);
}

main().catch((err) => {
  console.error("\nEnrichment failed:", err?.message ?? err);
  process.exit(1);
});
