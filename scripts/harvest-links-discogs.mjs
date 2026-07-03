#!/usr/bin/env node
// ============================================================
// Phase 2d: harvest platform links from Discogs.
//
// For each artist with a Discogs link in artist_links, calls the
// official Discogs API (GET /artists/{id}) and stages every external
// URL from the response's `urls` array into artist_harvested_links —
// never touching artist_links directly. integrate-harvested-links.mjs
// (2e) handles promotion and conflict-flagging, exactly as it does
// for SoundCloud web-profile finds.
//
// Processed state is tracked in the DATABASE (resolved_artists, with
// service = 'discogs-links'), not in cache files — per project
// convention. An artist is skipped if a state row exists, so re-runs
// only touch artists whose Discogs link arrived since the last run.
// That is what lets the 2d+2e convergence loop terminate.
//
// Rate limit: 60 requests/minute with a personal access token
// (throttled to ~55/min here to be safe).
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/harvest-links-discogs.mjs                 # all unprocessed artists with a discogs link
//   node scripts/harvest-links-discogs.mjs --limit=20      # only the first 20 (for testing)
//   node scripts/harvest-links-discogs.mjs --name="Danz"   # artists whose name contains this
//   node scripts/harvest-links-discogs.mjs --force         # re-process even artists with a state row
//   node scripts/harvest-links-discogs.mjs --debug         # log every URL classified
//   DRY_RUN=1 node scripts/harvest-links-discogs.mjs       # fetch + log, no DB writes
//
// Requires .env.local:
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, DISCOGS_TOKEN
// (Generate a token at discogs.com → Settings → Developers →
// "Generate new token" — no OAuth app needed.)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const STATE_SERVICE = "discogs-links"; // resolved_artists.service value

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

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
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.");
  process.exit(1);
}
if (!DISCOGS_TOKEN) {
  console.error(
    "Missing DISCOGS_TOKEN in .env.local.\n" +
      "Generate one at discogs.com → Settings → Developers → 'Generate new token'."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// ------------------------------------------------------------
// Paginated fetch (PostgREST caps unpaginated queries at 1000 rows).
// ------------------------------------------------------------
const PAGE_SIZE = 1000;

async function fetchAll(table, select, applyFilters = (q) => q) {
  const allRows = [];
  let from = 0;
  while (true) {
    let query = supabase.from(table).select(select).order("id", { ascending: true });
    query = applyFilters(query);
    query = query.range(from, from + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw error;
    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

// ------------------------------------------------------------
// URL classification. Same per-script-copy convention as
// integrate-harvested-links.mjs / harvest-soundcloud-links-and-bio.mjs.
// Unlike the SoundCloud harvester, soundcloud.com is NOT excluded
// here (Discogs is a different source, so a SoundCloud link is a
// real find). discogs.com self-links, Twitter/X (project policy),
// and wikidata.org are skipped.
// ------------------------------------------------------------
const DOMAIN_PLATFORM_MAP = [
  [/(^|\.)soundcloud\.com$/i, "soundcloud"],
  [/(^|\.)instagram\.com$/i, "instagram"],
  [/(^|\.)open\.spotify\.com$/i, "spotify"],
  [/(^|\.)spotify\.com$/i, "spotify"],
  [/(^|\.)spotify\.link$/i, "spotify"],
  [/(^|\.)youtube\.com$/i, "youtube"],
  [/(^|\.)youtu\.be$/i, "youtube"],
  [/(^|\.)residentadvisor\.net$/i, "resident_advisor"],
  [/(^|\.)ra\.co$/i, "resident_advisor"],
  [/(^|\.)bandcamp\.com$/i, "bandcamp"],
  [/(^|\.)facebook\.com$/i, "facebook"],
  [/(^|\.)fb\.me$/i, "facebook"],
  [/(^|\.)tiktok\.com$/i, "tiktok"],
  [/(^|\.)linktr\.ee$/i, "linktree"],
  [/(^|\.)beatport\.com$/i, "beatport"],
  [/(^|\.)qobuz\.com$/i, "qobuz"],
  [/(^|\.)tidal\.com$/i, "tidal"],
  [/(^|\.)songkick\.com$/i, "songkick"],
  [/(^|\.)music\.apple\.com$/i, "apple_music"],
  [/(^|\.)itunes\.apple\.com$/i, "apple_music"],
  [/(^|\.)last\.fm$/i, "lastfm"],
  [/(^|\.)lastfm\.[a-z]+$/i, "lastfm"],
  [/(^|\.)musicbrainz\.org$/i, "musicbrainz"],
  [/(^|\.)mixcloud\.com$/i, "other"],
];

const SKIP_HOST_REGEXES = [
  /(^|\.)(twitter\.com|x\.com|t\.co)$/i, // excluded per project policy
  /(^|\.)discogs\.com$/i, // self-link
  /(^|\.)wikidata\.org$/i, // not a platform we track (future harvester source)
];

function classifyUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // unparseable — skip entirely
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  for (const re of SKIP_HOST_REGEXES) {
    if (re.test(host)) return null;
  }
  if (host.endsWith(".wikipedia.org") || host === "wikipedia.org") {
    return { platform: "wikipedia", parsedUrl: normalizeUrl(url) };
  }
  for (const [re, platform] of DOMAIN_PLATFORM_MAP) {
    if (re.test(host)) return { platform, parsedUrl: normalizeUrl(url) };
  }
  return { platform: "other", parsedUrl: normalizeUrl(url) };
}

function normalizeUrl(url) {
  const u = new URL(url.toString());
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

// ------------------------------------------------------------
// Discogs API
// ------------------------------------------------------------
const THROTTLE_MS = 1100; // ~55 req/min, under the 60/min authenticated cap
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

function discogsArtistIdFromUrl(rawUrl) {
  // Matches discogs.com/artist/127045, /artist/127045-Aleja-Sanchez,
  // and localized paths like /de/artist/127045-....
  const m = String(rawUrl).match(/discogs\.com\/(?:[a-z]{2}\/)?artist\/(\d+)/i);
  return m ? m[1] : null;
}

async function fetchDiscogsArtist(discogsId, { retried = false } = {}) {
  await throttle();
  const res = await fetch(`https://api.discogs.com/artists/${discogsId}`, {
    headers: {
      "User-Agent": "RebalanceGender/1.0 +https://rebalance-gender.com",
      Authorization: `Discogs token=${DISCOGS_TOKEN}`,
    },
  });
  if (res.status === 429 && !retried) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    console.log(`  rate-limited; waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return fetchDiscogsArtist(discogsId, { retried: true });
  }
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json() };
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : "Harvesting platform links from Discogs\n"
  );

  // Artists with a discogs link (first link per artist wins, by id).
  const discogsLinks = await fetchAll(
    "artist_links",
    "id, artist_id, url, artists!inner(id, name)",
    (q) => {
      q = q.eq("platform", "discogs");
      if (NAME_FILTER) q = q.ilike("artists.name", `%${NAME_FILTER}%`);
      return q;
    }
  );

  const byArtist = new Map();
  for (const row of discogsLinks) {
    if (!byArtist.has(row.artist_id)) byArtist.set(row.artist_id, row);
  }

  // Already-processed state from the DB (not a cache file).
  const { data: stateRows, error: stateError } = await supabase
    .from("resolved_artists")
    .select("artist_id")
    .eq("service", STATE_SERVICE);
  if (stateError) throw stateError;
  const processed = new Set((stateRows ?? []).map((r) => r.artist_id));

  let targets = [...byArtist.values()].filter(
    (row) => FORCE || !processed.has(row.artist_id)
  );
  const skippedProcessed = byArtist.size - targets.length;
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`${byArtist.size} artist(s) have a Discogs link.`);
  if (skippedProcessed > 0 && !FORCE) {
    console.log(`${skippedProcessed} already processed (state in resolved_artists; use --force to redo).`);
  }
  console.log(`${targets.length} to process.\n`);

  let staged = 0;
  let failed = 0;
  let noUrls = 0;
  const stagedByPlatform = {};

  for (const row of targets) {
    const name = row.artists?.name ?? row.artist_id;
    const discogsId = discogsArtistIdFromUrl(row.url);

    if (!discogsId) {
      console.log(`✗ ${name}: could not parse artist id from ${row.url}`);
      failed++;
      if (!DRY_RUN) await markProcessed(row.artist_id);
      continue;
    }

    const res = await fetchDiscogsArtist(discogsId);
    if (!res.ok) {
      console.log(`✗ ${name}: Discogs HTTP ${res.status} for artist ${discogsId}`);
      failed++;
      // 404s are dead links — still mark processed so the loop can
      // converge; a future qc pass can deal with the link itself.
      if (!DRY_RUN && res.status === 404) await markProcessed(row.artist_id);
      continue;
    }

    const urls = Array.isArray(res.data?.urls) ? res.data.urls : [];
    const candidates = [];
    for (const rawUrl of urls) {
      const classified = classifyUrl(rawUrl);
      if (!classified) {
        if (DEBUG) console.log(`    (skipped: ${rawUrl})`);
        continue;
      }
      candidates.push({
        artist_id: row.artist_id,
        source_platform: "discogs",
        source_url: row.url,
        raw_url: rawUrl,
        parsed_platform: classified.platform,
        parsed_url: classified.parsedUrl,
      });
      if (DEBUG) console.log(`    ${classified.platform.padEnd(16)} ${classified.parsedUrl}`);
    }

    if (candidates.length === 0) {
      noUrls++;
      if (DEBUG) console.log(`· ${name}: no usable URLs (${urls.length} raw)`);
      if (!DRY_RUN) await markProcessed(row.artist_id);
      continue;
    }

    if (DRY_RUN) {
      console.log(`~ ${name}: would stage ${candidates.length} link(s)`);
      continue;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("artist_harvested_links")
      .upsert(candidates, { onConflict: "artist_id,parsed_url", ignoreDuplicates: true })
      .select("id, parsed_platform");

    if (insertError) {
      console.log(`✗ ${name}: failed to stage links: ${insertError.message}`);
      failed++;
      continue; // no state row — retry next run
    }

    const newRows = inserted ?? [];
    staged += newRows.length;
    for (const r of newRows) {
      stagedByPlatform[r.parsed_platform] = (stagedByPlatform[r.parsed_platform] ?? 0) + 1;
    }
    console.log(
      `✓ ${name}: ${newRows.length} new link(s) staged` +
        (candidates.length > newRows.length
          ? ` (${candidates.length - newRows.length} already staged)`
          : "")
    );

    await markProcessed(row.artist_id);
  }

  console.log(`\nDone. ${staged} new link(s) staged, ${noUrls} artist(s) with no usable URLs, ${failed} failure(s).`);
  if (Object.keys(stagedByPlatform).length > 0) {
    console.log("New staged links by platform:");
    for (const [platform, count] of Object.entries(stagedByPlatform).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${platform}: ${count}`);
    }
  }
  if (staged > 0) {
    console.log("\nNext: node scripts/integrate-harvested-links.mjs (2e) to promote staged links.");
  }
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

main().catch((err) => {
  console.error("\nHarvest failed:", err?.message ?? err);
  process.exit(1);
});
