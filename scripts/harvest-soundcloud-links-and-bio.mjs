#!/usr/bin/env node
// ============================================================
// SoundCloud link + bio harvesting (staging only — does NOT touch
// artist_links, artist_enrichment, or the live app).
//
// Uses the OFFICIAL SoundCloud API (api.soundcloud.com), not HTML
// scraping. An earlier version of this script tried to scrape the
// "Links" section (the row of platform icons under an artist's bio
// on their SoundCloud page) out of the page's HTML, on the
// assumption that it was embedded in a `window.__sc_hydration` JSON
// blob server-rendered into the page. That assumption turned out to
// be wrong: the Links section is rendered entirely client-side by
// SoundCloud's JavaScript and is simply absent from the HTML a
// plain HTTP fetch receives — confirmed by fetching
// https://soundcloud.com/jeannedearc directly and finding no trace
// of it. The official API exposes the same data cleanly instead:
//
//   GET /resolve?url=<profile url>
//     -> the user's resource, including `urn` and the full,
//        untruncated `description` (bio) text.
//   GET /users/{urn}/web-profiles
//     -> the exact "Links" section data: an array of
//        { service, url, title, username, ... }.
//
// For each artist with a SoundCloud profile link, this script:
//
//   1. Resolves their profile URL to get their user resource (urn +
//      raw bio).
//   2. Fetches their web-profiles (the Links section) and classifies
//      each URL by domain (Instagram, Spotify, YouTube, Resident
//      Advisor, Bandcamp, Facebook, TikTok, Linktree, Beatport,
//      Discogs, personal websites -> "other"). Twitter/X is always
//      skipped, and Instagram URLs have their query string (?hl=en
//      etc.) stripped.
//   3. Also scans the raw bio text itself for any plain URLs to
//      those same platforms (gate.sc-style click-tracking wrappers
//      don't appear in API data — those are a SoundCloud *web
//      client* rendering behavior — but the decoder is kept as a
//      defensive no-op in case one ever shows up here).
//
// Both the harvested links and the raw bio are written to dedicated
// staging tables — artist_harvested_links and artist_harvested_bios
// — NOT to artist_links or artist_enrichment. Both tables
// intentionally have no RLS policy for anon/authenticated, so
// they're invisible to the public site and the admin UI. A separate,
// later process will review and decide how to incorporate this data
// into the live tables.
//
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
//   node scripts/harvest-soundcloud-links-and-bio.mjs                  # all artists with a SoundCloud link
//   node scripts/harvest-soundcloud-links-and-bio.mjs --approved       # only artists in the directory (directory_status = 'approved')
//   node scripts/harvest-soundcloud-links-and-bio.mjs --limit=20       # only the first 20 (for testing)
//   node scripts/harvest-soundcloud-links-and-bio.mjs --force          # re-process even artists with existing state
//   node scripts/harvest-soundcloud-links-and-bio.mjs --debug          # log raw web-profiles + every candidate link found per artist
//   DRY_RUN=1 node scripts/harvest-soundcloud-links-and-bio.mjs        # fetch + log, don't write to the DB
//
// One API resolve call + one web-profiles call per artist with a
// SoundCloud link, with a short delay between artists to be polite.
// SoundCloud does not currently enforce a global aggregate rate
// limit, but Client Credentials tokens are limited (50/12h per app,
// 30/hr per IP) — this script fetches one token and reuses it for
// the whole run, refreshing only on a 401.
//
// Processed state is tracked in the DATABASE (resolved_artists, with
// service = 'soundcloud-harvest'), not in a cache file — per project
// convention. An artist is skipped once a state row exists for it;
// --force bypasses this and re-processes everyone. An artist is only
// marked processed after its staged rows (links + bio) are written
// successfully, or after a resolve failure that's a definitive dead
// link (404) — other failures (timeouts, rate limits, DB write
// errors) are left unmarked so the next run retries them
// automatically.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DEBUG = args.includes("--debug");
// --approved: only process artists in the live directory
// (directory_status = 'approved'), rather than every artist with a
// SoundCloud link (which is dominated by unvetted follow-graph nodes).
const APPROVED_ONLY = args.includes("--approved");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

const STATE_SERVICE = "soundcloud-harvest"; // resolved_artists.service value

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
// Processed-state tracking via resolved_artists (DB), not a cache
// file. Same pattern as harvest-links-discogs.mjs: an artist is
// skipped once a row exists for (artist_id, service); --force
// bypasses the skip. markProcessed is only called after the staged
// rows for an artist are written successfully, or after a resolve
// failure that's a definitive dead link (404) — other failures are
// left unmarked so the next run retries them automatically.
// ------------------------------------------------------------
async function loadProcessedArtistIds() {
  // Paginated: PostgREST caps unpaginated selects at 1000 rows, and
  // there can be more state rows than that. Ordered by artist_id
  // (the PK's first column) for stable pages.
  const STATE_PAGE_SIZE = 1000;
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("resolved_artists")
      .select("artist_id")
      .eq("service", STATE_SERVICE)
      .order("artist_id", { ascending: true })
      .range(from, from + STATE_PAGE_SIZE - 1);
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.artist_id);
    if ((data?.length ?? 0) < STATE_PAGE_SIZE) break;
    from += STATE_PAGE_SIZE;
  }
  return ids;
}

async function markProcessed(artistId) {
  const { error } = await supabase
    .from("resolved_artists")
    .upsert(
      { artist_id: artistId, service: STATE_SERVICE, resolved_at: new Date().toISOString() },
      { onConflict: "artist_id,service" }
    );
  if (error) console.error(`  (failed to record state for ${artistId}: ${error.message})`);
}

// ------------------------------------------------------------
// SoundCloud OAuth (Client Credentials flow — app-only, public
// resources). One token is fetched and reused for the whole run;
// it's refreshed if a request comes back 401.
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
// Authenticated GET against the SoundCloud API, with one retry on
// 401 (refreshes the token) and one retry on 429 (waits, then
// retries once — SoundCloud doesn't currently enforce a global
// aggregate limit, so this is just a safety net).
// ------------------------------------------------------------
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

async function resolveUser(scUrl) {
  return soundcloudGet(`/resolve?url=${encodeURIComponent(scUrl)}`);
}

async function getWebProfiles(urn) {
  return soundcloudGet(`/users/${encodeURIComponent(urn)}/web-profiles`);
}

// ------------------------------------------------------------
// gate.sc is a link-click tracker the SoundCloud *web client* wraps
// outbound bio URLs in when rendering them as clickable, e.g.:
//   https://gate.sc/?url=https%3A%2F%2Fwww.instagram.com%2Fdanz_cm%2F&token=...
// That rewriting happens in the browser, not in the API's stored
// data, so this should normally be a no-op against API responses —
// kept as a defensive fallback in case it ever shows up.
// ------------------------------------------------------------
const GATE_SC_REGEX = /https?:\/\/gate\.sc\/?\?url=([^&\s"'<>]+)(?:&[^\s"'<>]*)*/gi;

function extractGateScTargets(text) {
  const out = [];
  for (const match of text.matchAll(GATE_SC_REGEX)) {
    try {
      out.push(decodeURIComponent(match[1]));
    } catch {
      // malformed encoding — skip it
    }
  }
  return out;
}

// ------------------------------------------------------------
// Plain URLs to known platforms mentioned directly in bio text,
// e.g. "more music: https://open.spotify.com/artist/..."
// ------------------------------------------------------------
const PLAIN_URL_REGEX = /https?:\/\/[^\s"'<>)]+/gi;

function extractPlainUrls(text) {
  const matches = text.match(PLAIN_URL_REGEX) ?? [];
  // Trim trailing punctuation a sentence might leave attached.
  return matches.map((u) => u.replace(/[.,;:!?)]+$/, ""));
}

// ------------------------------------------------------------
// Platform classification
// ------------------------------------------------------------
const DOMAIN_PLATFORM_MAP = [
  [/(^|\.)instagram\.com$/i, "instagram"],
  [/(^|\.)open\.spotify\.com$/i, "spotify"],
  [/(^|\.)spotify\.link$/i, "spotify"],
  [/(^|\.)youtube\.com$/i, "youtube"],
  [/(^|\.)youtu\.be$/i, "youtube"],
  [/(^|\.)music\.youtube\.com$/i, "youtube"],
  [/(^|\.)residentadvisor\.net$/i, "resident_advisor"],
  [/(^|\.)ra\.co$/i, "resident_advisor"],
  [/(^|\.)bandcamp\.com$/i, "bandcamp"],
  [/(^|\.)facebook\.com$/i, "facebook"],
  [/(^|\.)fb\.me$/i, "facebook"],
  [/(^|\.)tiktok\.com$/i, "tiktok"],
  [/(^|\.)linktr\.ee$/i, "linktree"],
  [/(^|\.)beatport\.com$/i, "beatport"],
  [/(^|\.)discogs\.com$/i, "discogs"],
];

const TWITTER_HOST_REGEX = /(^|\.)(twitter\.com|x\.com)$/i;
const SOUNDCLOUD_HOST_REGEX = /(^|\.)soundcloud\.com$/i;

function classify(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (TWITTER_HOST_REGEX.test(host)) return null; // excluded per project policy
  if (SOUNDCLOUD_HOST_REGEX.test(host)) return null; // self-link, not useful

  for (const [hostRegex, platform] of DOMAIN_PLATFORM_MAP) {
    if (hostRegex.test(host)) return platform;
  }

  // Unrecognized external domain — still worth keeping as a generic
  // candidate (e.g. a personal site), per the broader
  // platform-coverage decision for this harvest. Classified as
  // "other" (not "website") to match the existing "other" key in
  // the platforms table.
  return "other";
}

function normalizeUrl(rawUrl, platform) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (platform === "instagram") {
    url.search = "";
    url.hash = "";
  }
  // Strip a single trailing slash from the path (but never the bare
  // root "/") so "https://instagram.com/danz_cm/" and
  // ".../danz_cm" are treated as the same URL — both for deduping
  // candidates found on the same page, and so URLs saved here match
  // consistently against whatever's already in artist_links later.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

// ------------------------------------------------------------
// Resolve an artist's SoundCloud URL via the official API and
// return:
//   - candidates: every (rawUrl, platform, parsedUrl) triple found
//     in their web-profiles + bio text
//   - rawBio: the full, unparsed bio text (the API's `description`
//     field), or null if not set
// ------------------------------------------------------------
async function harvestFromSoundCloud(scUrl) {
  const userRes = await resolveUser(scUrl);
  if (!userRes.ok || !userRes.data) {
    if (DEBUG) console.log(`  [debug] resolve failed (status ${userRes.status})`);
    return { ok: false, status: userRes.status, candidates: [], rawBio: null };
  }

  const user = userRes.data;
  const urn = user.urn ?? (user.id != null ? `soundcloud:users:${user.id}` : null);
  const rawBio =
    typeof user.description === "string" && user.description.trim()
      ? user.description.trim()
      : null;

  const candidatesRaw = [];

  if (urn) {
    const profilesRes = await getWebProfiles(urn);
    if (profilesRes.ok && Array.isArray(profilesRes.data)) {
      if (DEBUG) {
        console.log("  [debug] web-profiles raw:", JSON.stringify(profilesRes.data));
      }
      for (const p of profilesRes.data) {
        if (typeof p?.url === "string" && p.url.trim()) {
          candidatesRaw.push({
            rawUrl: p.url.trim(),
            source: `web-profiles:${p.service ?? "?"}`,
          });
        }
      }
    } else if (DEBUG) {
      console.log(`  [debug] web-profiles fetch failed (status ${profilesRes.status})`);
    }
  } else if (DEBUG) {
    console.log("  [debug] no urn on resolved user, skipping web-profiles");
  }

  if (rawBio) {
    for (const target of extractGateScTargets(rawBio)) {
      candidatesRaw.push({ rawUrl: target, source: "bio:gate.sc" });
    }
    for (const plain of extractPlainUrls(rawBio)) {
      if (/gate\.sc/i.test(plain)) continue;
      candidatesRaw.push({ rawUrl: plain, source: "bio:plain" });
    }
  }

  if (DEBUG) {
    console.log("  [debug] all candidates:", JSON.stringify(candidatesRaw));
  }

  const seen = new Set();
  const candidates = [];
  for (const { rawUrl, source } of candidatesRaw) {
    const platform = classify(rawUrl);
    if (!platform) continue;
    const parsedUrl = normalizeUrl(rawUrl, platform);
    const dedupeKey = `${platform}|${parsedUrl}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({ rawUrl, source, platform, parsedUrl });
  }

  return { ok: true, candidates, rawBio };
}

// ------------------------------------------------------------
// Supabase's REST API (PostgREST) caps any single unpaginated query
// at 1000 rows by default, regardless of how many rows actually
// match — silently, with no error or truncation flag. We have well
// over that many SoundCloud links, so fetch in pages of 1000 via
// .range() until a page comes back short, ordered by the
// artist_links row id so pagination is stable across pages.
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

    if (APPROVED_ONLY) {
      query = query.eq("artists.directory_status", "approved").eq("artists.deleted", false);
    }

    if (NAME_FILTER) {
      query = query.ilike("artists.name", `%${NAME_FILTER}%`);
    }

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
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running SoundCloud link + bio harvest\n");

  // Fail fast on bad credentials rather than burning through every
  // artist first.
  await getAccessToken();
  console.log("SoundCloud API token acquired.\n");

  const processed = FORCE ? new Set() : await loadProcessedArtistIds();
  if (FORCE) {
    console.log("--force: bypassing resolved_artists state\n");
  } else if (processed.size > 0) {
    console.log(`State loaded: ${processed.size} artist(s) already processed (resolved_artists; pass --force to bypass)\n`);
  }

  // Pull every SoundCloud link directly off artist_links (an artist
  // could in principle have more than one SoundCloud account).
  // Paginated — see fetchAllSoundCloudLinks for why.
  const links = await fetchAllSoundCloudLinks();

  // Exclude already-processed artists BEFORE applying --limit, so
  // --limit always means "the next N artists that haven't been
  // processed yet", not "the first N in the query, even if most of
  // them are already done". --force bypasses the state (it's an
  // empty Set in that case), so nothing is excluded here.
  let rows = links;
  let skippedProcessed = 0;
  if (!FORCE) {
    const remaining = [];
    for (const row of links) {
      if (processed.has(row.artist_id)) {
        skippedProcessed++;
      } else {
        remaining.push(row);
      }
    }
    rows = remaining;
  }
  if (LIMIT) rows = rows.slice(0, LIMIT);

  if (APPROVED_ONLY) {
    // An artist can hold more than one SoundCloud link row, so count
    // distinct artists — that's the meaningful "approved artists that
    // will be processed" figure.
    const approvedArtistCount = new Set(rows.map((r) => r.artist_id)).size;
    console.log(
      `--approved: restricting to directory artists (directory_status = 'approved')`
    );
    console.log(
      `${approvedArtistCount} approved artist(s) will be processed this run.\n`
    );
  }

  console.log(
    `Found ${links.length} SoundCloud link(s) on ${APPROVED_ONLY ? "approved " : ""}artists` +
      (skippedProcessed > 0 ? `, ${skippedProcessed} already processed (skipped)` : "") +
      `${LIMIT ? `, processing next ${rows.length}` : ""}\n`
  );

  let scraped = 0;
  let fetchFailed = 0;
  let totalLinksFound = 0;
  let totalLinksWritten = 0;
  let biosFound = 0;
  let biosWritten = 0;
  const byPlatform = {};

  for (const row of rows) {
    const name = row.artists?.name ?? row.artist_id;
    const scUrl = row.url;

    scraped++;
    const { ok, status, candidates, rawBio } = await harvestFromSoundCloud(scUrl);
    let writeFailed = false;

    if (!ok) {
      fetchFailed++;
      console.log(`✗ ${name}: failed to resolve ${scUrl}`);
      // Only a 404 is a definitive dead link — mark it processed so
      // it doesn't retry forever. Timeouts, rate limits, and other
      // HTTP errors are transient, so leave them unmarked.
      if (!DRY_RUN && status === 404) await markProcessed(row.artist_id);
    } else {
      totalLinksFound += candidates.length;
      if (rawBio) biosFound++;

      const bioPreview = rawBio
        ? `"${rawBio.slice(0, 60)}${rawBio.length > 60 ? "…" : ""}"`
        : "(no bio)";
      if (candidates.length === 0) {
        console.log(`~ ${name}: no other-platform links found, ${bioPreview}`);
      } else {
        console.log(
          `✓ ${name}: ${candidates.length} link(s) — ${candidates
            .map((c) => c.platform)
            .join(", ")}, ${bioPreview}`
        );
      }

      if (!DRY_RUN) {
        if (candidates.length > 0) {
          const { error: insertError } = await supabase
            .from("artist_harvested_links")
            .upsert(
              candidates.map((c) => ({
                artist_id: row.artist_id,
                source_platform: "soundcloud",
                source_url: scUrl,
                raw_url: c.rawUrl,
                parsed_platform: c.platform,
                parsed_url: c.parsedUrl,
              })),
              { onConflict: "artist_id,parsed_url", ignoreDuplicates: true }
            );
          if (insertError) {
            console.error(`  failed to save links: ${insertError.message}`);
            writeFailed = true;
          } else {
            totalLinksWritten += candidates.length;
          }
        }

        if (rawBio) {
          const { error: bioError } = await supabase
            .from("artist_harvested_bios")
            .upsert(
              {
                artist_id: row.artist_id,
                source_platform: "soundcloud",
                source_url: scUrl,
                raw_bio: rawBio,
                fetched_at: new Date().toISOString(),
              },
              { onConflict: "artist_id,source_platform" }
            );
          if (bioError) {
            console.error(`  failed to save bio: ${bioError.message}`);
            writeFailed = true;
          } else {
            biosWritten++;
          }
        }

        // Only mark the artist processed once its staged rows are
        // actually written — a write failure leaves it unmarked so
        // the next run retries it.
        if (!writeFailed) await markProcessed(row.artist_id);
      } else {
        totalLinksWritten += candidates.length;
        if (rawBio) biosWritten++;
      }

      for (const c of candidates) {
        byPlatform[c.platform] = (byPlatform[c.platform] ?? 0) + 1;
      }
    }

    await sleep(300);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  processed:              ${scraped}`);
  console.log(`  skipped (processed):    ${skippedProcessed}`);
  console.log(`  resolve failed:         ${fetchFailed}`);
  console.log(`  total links found:      ${totalLinksFound}`);
  console.log(`  total links ${DRY_RUN ? "(would be) written" : "written"}: ${totalLinksWritten}`);
  for (const [platform, count] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${platform}: ${count}`);
  }
  console.log(`  bios found:             ${biosFound}`);
  console.log(`  bios ${DRY_RUN ? "(would be) written" : "written"}:      ${biosWritten}`);
}

main().catch((err) => {
  console.error("\nHarvest failed:", err?.message ?? err);
  process.exit(1);
});
