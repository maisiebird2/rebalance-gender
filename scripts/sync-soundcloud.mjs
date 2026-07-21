#!/usr/bin/env node
// ============================================================
// SoundCloud sync: the merged Phase 2 SoundCloud stage.
//
// Replaces the former two-script pair — enrich-soundcloud.mjs (2a) and
// harvest-soundcloud-links-and-bio.mjs (2b) — which each called
// GET /resolve?url=<profile-url> separately for the same artist, the
// same call returning the same user resource. This stage makes that
// call once per artist and fans the result out to both concerns:
//
//   GET /resolve?url=<profile url>   (first sync only)
//     -> the user's resource: follower/track counts, avatar, numeric
//        id, urn, and the full, untruncated `description` (bio) text.
//        Bio/follower/track data written to artist_enrichment
//        (platform = 'soundcloud'); the avatar goes to artist_images
//        (platform = 'soundcloud') instead — see "Image handling"
//        below. On re-runs the same resource is fetched by the stored
//        numeric id instead (GET /users/{id}), skipping /resolve — see
//        "Fetch by stored id on re-runs" below.
//   GET /users/{urn}/web-profiles
//     -> the "Links" section: an array of { service, url, title, ... }
//        pointing at the artist's other platforms. Staged into
//        artist_harvested_links (never written directly to
//        artist_links — integrate-harvested-links.mjs, Phase 2d,
//        promotes it).
//   GET /users/{id}/playlists   (conditional)
//     -> only fetched when track_count is 0 (no uploads of their own,
//        often a repost/podcast account). There's no public API
//        endpoint for a user's reposts, so playlists are the best
//        available fallback content for the artist page's widget.
//
// Fetch by stored id on re-runs: the first successful sync records the
// user's numeric id in artist_enrichment.external_id. On any later run
// for that artist (a --force re-sync, a link-changed retry, the
// image-only pass, or --links-only), main() preloads those ids and
// syncArtist fetches the user resource by id — GET /users/{id} —
// instead of GET /resolve?url=<profile-url>. Same resource, same cost,
// but it skips the resolve step and is immune to the artist renaming
// their profile URL (the id never changes, whereas a rename breaks the
// stored URL and would 404 a resolve). Resolve-by-URL only runs on the
// first sync, when no id exists yet — which is also the only path where
// the wrong-field guard below is meaningful (a stored id means the URL
// already resolved cleanly once). If a fetch-by-id itself 404s (the
// account was deleted/recreated, so the stored id is now stale), it
// falls back to resolving the current URL once, so an account move
// recovers automatically rather than being stuck on the dead id.
//
// --links-only refresh: re-fetches ONLY the web-profiles "Links"
// section (from the stored id, one API call, no /resolve) and re-stages
// the harvested links, for every already-synced artist matching the
// filters. Skips the user resource, bio, image, and playlists, and
// touches no completion/failure state — a links refresh doesn't change
// main-sync completeness, so there's nothing to mark done or un-stick;
// failures are logged and tallied only. See main()'s LINKS_ONLY branch
// and syncArtist's linksOnly path.
//
// Two API calls per artist is the floor for a full sync — SoundCloud
// has no endpoint that returns the user resource and web-profiles
// together — down from three under the old two-script version. The bio
// path is also unified: the parsed/cleaned bio goes to the live
// artist_enrichment.bio (same as old 2a), while the full raw bio text
// is additionally kept in artist_harvested_bios as a raw-bio audit
// trail (old 2b staged it there too, but nothing consumed it — this
// keeps that behavior, now as a deliberate audit record rather than a
// dead end).
// Two API calls per artist is the floor — SoundCloud has no endpoint
// that returns the user resource and web-profiles together — down
// from three under the old two-script version. The bio fans out three
// ways: the parsed/cleaned bio goes to the live artist_enrichment.bio
// (same as old 2a) and to biographies (platform = 'soundcloud', the
// one-bio-per-artist-per-platform home shared with sync-discogs/-
// bandcamp), while the full raw bio text is additionally kept in
// artist_harvested_bios as a raw-bio audit trail (old 2b staged it
// there too, but nothing consumed it — this keeps that behavior, now
// as a deliberate audit record rather than a dead end).
//
// Wrong-field URL guard: before spending an API call, the stored
// artist_links.url is checked against soundcloud.com. A stored link
// that's actually a Spotify/Instagram/whatever URL (a data-entry or
// form-submission mistake, not a dead SoundCloud profile) is skipped
// without calling /resolve, and logged to harvest_failures instead —
// see scripts/PIPELINE.md, "Guard harvesters against wrong-field
// URLs" (found via a real case: a wrong-field URL burned a /resolve
// call, got 404-marked processed, and left no record of why). Like a
// 404, a wrong-field mismatch DOES mark the artist processed — the
// mismatch doesn't fix itself on retry, so leaving it unmarked would
// just re-write the same harvest_failures row and re-run the same
// guard check on every future run forever, for no benefit. See "A
// 404-marked artist isn't stuck forever" below for how a later fix
// still gets picked up without --force.
//
// Failure persistence: every resolve/write failure — wrong-field
// skips, 404s, transient resolve failures, and DB write failures — is
// recorded in the harvest_failures table (service = 'soundcloud-sync')
// via scripts/lib/harvest-failures.mjs, so a scheduled/unattended run's
// failures are queryable afterward instead of living only in
// scrollback. A later successful sync clears the row.
//
// Failures CSV: every run (DRY_RUN or not) also writes a snapshot of
// every current soundcloud-sync row in harvest_failures to a
// timestamped CSV — artist name, the artist's Rebalance Gender page
// URL, status, the failed url, and occurred_at — one level up from
// this repo (the "Rebalance Gender" folder), so re-running never
// overwrites a previous run's report. See writeFailuresCsv().
//
// Image handling: the resolved user's avatar is written to
// artist_images (artist_id, platform='soundcloud'), never to
// artist_enrichment.profile_image_url (explicitly nulled in that
// upsert, so a pre-migration value doesn't linger looking
// authoritative) — see supabase_migration_artist_images.sql.
// "No real image" cases are recorded, not silently skipped: an account
// with no avatar at all (no_avatar), and one whose avatar_url is
// SoundCloud's generic grey default_avatar placeholder (detected by
// isDefaultAvatarUrl — returned for accounts with no photo). Neither is
// stored; both are recorded under IMAGE_STATE_SERVICE like any other
// image failure, so the image-only pass stops re-resolving them every
// run. As with any URL-keyed failure, an image added later at the
// unchanged profile URL is only picked up on --force (or a link change).
// Directory-only, unconditionally: the image write only happens when
// this artist's directory_status is 'approved' at the moment
// syncArtist() runs, checked inline regardless of which flags scoped
// this call — unlike bio/links/tracks, this script otherwise
// processes non-directory artists too (follow-graph nodes, ~100x more
// numerous than directory ones), and there's no reason to store or
// re-host images for artists that aren't shown anywhere.
//
// Image completion is tracked independently from the main
// 'soundcloud-sync' completion (resolved_artists), because the two
// can now legitimately diverge: an artist can be fully bio/links
// synced as a non-directory node, then get approved into the
// directory later — at that point only the image is missing, not a
// full re-sync. main() detects this (approved, resolved_artists
// already has a 'soundcloud-sync' row, but no artist_images row for
// soundcloud yet) and routes those artists through syncArtist() with
// { imageOnly: true }: still one /resolve call (the only way to get
// the avatar — no cheaper endpoint), but skipping playlists,
// web-profiles, and every bio/link write, since those are already
// done. Image-only failures are recorded under their own
// harvest_failures service ('image-sync:soundcloud', see
// IMAGE_STATE_SERVICE below) rather than 'soundcloud-sync', so a
// 404/dead-link discovered by the image-only path doesn't pollute the
// main sync's failure state (which already succeeded for this
// artist) — and so a fix to the link is picked up automatically next
// run via the same link-changed-since-failure cross-check
// 'soundcloud-sync' already uses (see loadFailureUrls in main()).
//
// Single per-artist unit: the actual sync logic lives in the exported
// syncArtist() function below. The CLI loop in main() is a thin driver
// over it — the same shape a future event-triggered call (e.g. "sync
// this one artist from SoundCloud on admin approval", the same pattern
// src/lib/scrape-images.ts already uses for images) can call directly
// for a single artist instead of a bulk run.
//
// Uses upserts throughout, so re-running refreshes existing rows
// rather than creating duplicates.
//
// Requires SoundCloud API credentials (Artist Pro + registered app):
//   SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET in .env.local
//   (also NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY)
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/sync-soundcloud.mjs                    # all artists with a SoundCloud link
//   node scripts/sync-soundcloud.mjs --approved         # only artists in the directory (directory_status = 'approved')
//   node scripts/sync-soundcloud.mjs --limit=20         # next 20 unprocessed (for testing)
//   node scripts/sync-soundcloud.mjs --force            # re-process even artists with existing state
//   node scripts/sync-soundcloud.mjs --name=jeanne      # filter source artists by name
//   node scripts/sync-soundcloud.mjs --status=sc_followee
//                                                        # only artists with this directory_status
//   node scripts/sync-soundcloud.mjs --links-only       # refresh just the web-profiles "Links" for already-synced artists (1 call each, no /resolve)
//   node scripts/sync-soundcloud.mjs --debug            # log raw API responses + every candidate link found
//   DRY_RUN=1 node scripts/sync-soundcloud.mjs          # fetch + log, no DB writes
//
// Processed state is tracked in the DATABASE (resolved_artists, with
// service = 'soundcloud-sync'), not a cache file — per project
// convention. An artist is skipped once a state row exists; --force
// bypasses this and re-processes everyone. --limit counts from the
// remaining unprocessed artists, not the full list, so repeated
// --limit runs make forward progress. An artist is marked processed
// after every write for it succeeds, or on either of the two failure
// statuses that syncArtist() treats as permanent-until-a-human-fixes-
// it: a resolve HTTP 404 (definitive dead link) and a wrong-field URL
// (definitively not a SoundCloud link). Transient failures (timeouts,
// rate limits, DB write errors) are presumed possibly-temporary and
// left unmarked, so the next run retries them automatically without
// needing any of the machinery below.
//
// A 404- or wrong-field-marked artist isn't stuck forever, though:
// resolved_artists only records "done for this artist_id", not which
// URL was checked, so on its own a fixed link would stay skipped
// indefinitely. Each run cross-references the URL harvest_failures
// recorded at failure time against the artist's current artist_links
// row; if they differ (a human corrected the link since), that one
// artist is retried this run instead of requiring --force, which
// would reprocess everyone.
//
// Artists already synced under the old two-script system have
// resolved_artists rows for 'soundcloud-enrich' and
// 'soundcloud-harvest', not 'soundcloud-sync' — see
// backfill-resolved-soundcloud-sync.mjs to seed the new service's
// state from those before running this in bulk, so the first run
// doesn't re-fetch everyone from scratch.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinktree } from "./lib/linktree.mjs";
import { decodeEntities, isGenericDescription, parseDescription, decodeGateSc } from "./lib/soundcloud-bio.mjs";
import { recordFailure, clearFailure, loadFailureUrls } from "./lib/harvest-failures.mjs";
import { IMAGE_FAILURE_STATUS, imageFailureService } from "../src/lib/images/failures.mjs";
import {
  createSoundcloudClient,
  sleep,
  SOUNDCLOUD_HOST_REGEX,
  isSoundCloudUrl,
  upgradeAvatarUrl,
  isDefaultAvatarUrl,
} from "./lib/soundcloud.mjs";
import { canonicalizeResidentAdvisorUrl } from "./lib/ra-url.mjs";

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
// SoundCloud link (mostly unvetted sc_followee follow-graph nodes).
// Forwarded verbatim by the orchestrator/loop scripts.
const APPROVED_ONLY = args.includes("--approved");
// --links-only: refresh just the web-profiles "Links" section for
// already-synced artists (those with a stored SoundCloud id), one API
// call each and no /resolve. Skips the user resource, bio, image, and
// playlists; touches no completion/failure state. See main()'s
// LINKS_ONLY branch and syncArtist's linksOnly path.
const LINKS_ONLY = args.includes("--links-only");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;
const statusArg = args.find((a) => a.startsWith("--status="));
const STATUS_FILTER = statusArg ? statusArg.slice("--status=".length) : null;

const STATE_SERVICE = "soundcloud-sync"; // resolved_artists.service / harvest_failures.service value
// harvest_failures.service value for the image-only path — deliberately
// separate from STATE_SERVICE; see "Image handling" above.
// Shared across every source that acquires images, so a scrape fallback
// and this API path write the same row rather than two half-answers in
// separate namespaces. See src/lib/images/failures.mjs.
const IMAGE_STATE_SERVICE = imageFailureService("soundcloud");

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
// Used only to build the artist-page URL in the failures CSV (see
// writeFailuresCsv) — same env var and fallback the site itself uses
// (src/lib/email.ts, src/app/layout.tsx).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rebalance-gender.app";

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

// Shared SoundCloud API client (OAuth token + GET wrapper) — see
// scripts/lib/soundcloud.mjs, shared with build-soundcloud-follow-graph.mjs.
const sc = createSoundcloudClient({ debug: DEBUG });

// ------------------------------------------------------------
// Processed-state tracking via resolved_artists (DB), not a cache
// file — same pattern as every other Phase 2 stage. An artist is
// skipped once a row exists for (artist_id, service); --force bypasses
// the skip. markProcessed is only called after every write for an
// artist succeeds, or after a resolve failure that's a definitive dead
// link (404) — other failures, and wrong-field-URL skips, are left
// unmarked so the next run retries them automatically.
// ------------------------------------------------------------
async function loadProcessedArtistIds() {
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
// Artists that already have a Linktree link (artist_links, platform =
// 'linktree'), preloaded once so a Linktree URL found in a bio only
// gets written when the artist doesn't already have one.
// ------------------------------------------------------------
async function loadArtistIdsWithLinktreeLink() {
  const PAGE_SIZE = 1000;
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("artist_links")
      .select("artist_id")
      .eq("platform", "linktree")
      .order("artist_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.artist_id);
    if ((data?.length ?? 0) < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return ids;
}

// ------------------------------------------------------------
// Artist IDs that already have a stored SoundCloud image
// (artist_images, platform='soundcloud') — preloaded once so main()
// can tell which already-synced, approved artists still need the
// lighter image-only pass. Presence of the row is what matters here,
// not whether it's been re-hosted to Storage yet (that's
// store-images.mjs's separate concern).
// ------------------------------------------------------------
async function fetchArtistIdsWithSoundcloudImage() {
  const PAGE_SIZE = 1000;
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("artist_images")
      .select("artist_id")
      .eq("platform", "soundcloud")
      .order("artist_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.artist_id);
    if ((data?.length ?? 0) < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return ids;
}

// ------------------------------------------------------------
// Numeric SoundCloud user ids for a SPECIFIC set of artists, from the
// external_id a prior successful sync stored in artist_enrichment
// (platform='soundcloud'). Scoped by artist_id via chunked .in()
// queries (which ride the (artist_id, platform) unique index) rather
// than paging through the whole enrichment table — that table carries a
// row per follow-graph node too (100x the directory) and is far too
// large to scan in full. Called with just the artists a run is about to
// process, so re-runs can fetch the user resource by id (/users/{id})
// instead of re-resolving the profile URL — see syncArtist's fetch
// step. Artists without a stored id (never synced, or synced before
// external_id existed) simply aren't in the map and fall back to
// resolve-by-URL. Returns Map<artist_id, id-string>.
// ------------------------------------------------------------
async function fetchScUserIdsForArtists(artistIds) {
  const CHUNK = 500;
  const map = new Map();
  const ids = [...new Set(artistIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("artist_enrichment")
      .select("artist_id, external_id")
      .eq("platform", "soundcloud")
      .not("external_id", "is", null)
      .in("artist_id", batch);
    if (error) throw error;
    for (const r of data ?? []) {
      const id = r.external_id != null ? String(r.external_id).trim() : "";
      if (id) map.set(r.artist_id, id);
    }
  }
  return map;
}

// Wrong-field URL guard (isSoundCloudUrl / SOUNDCLOUD_HOST_REGEX), the
// OAuth token flow + authenticated GET wrapper (via the `sc` client
// created above), and the avatar-URL upgrade all now live in
// scripts/lib/soundcloud.mjs, shared with build-soundcloud-follow-graph.mjs.

// ------------------------------------------------------------
// gate.sc is a link-click tracker the SoundCloud *web client* wraps
// outbound bio URLs in when rendering them as clickable. That
// rewriting happens in the browser, not in the API's stored data, so
// this should normally be a no-op against API responses — kept as a
// defensive fallback in case it ever shows up.
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
  return matches.map((u) => u.replace(/[.,;:!?)]+$/, ""));
}

// ------------------------------------------------------------
// Platform classification for harvested links (web-profiles + bio
// URLs). Same per-script-copy convention as every other harvester in
// this folder (integrate-harvested-links.mjs, sync-discogs.mjs)
// rather than a shared import.
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
  // candidate (e.g. a personal site). Classified as "other" to match
  // the existing "other" key in the platforms table.
  return "other";
}

function normalizeUrl(rawUrl, platform) {
  // Rewrite pre-rebrand residentadvisor.net links onto ra.co before storing.
  rawUrl = canonicalizeResidentAdvisorUrl(rawUrl);
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
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

// ------------------------------------------------------------
// Classify + normalize + dedupe raw candidate links (from web-profiles
// and/or bio scanning) into the { rawUrl, source, platform, parsedUrl }
// rows staged to artist_harvested_links. Shared by the full sync and
// the --links-only refresh path.
// ------------------------------------------------------------
function buildCandidates(candidatesRaw) {
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
  return candidates;
}

// ------------------------------------------------------------
// Upsert staged candidate links into artist_harvested_links (Phase 2d,
// integrate-harvested-links.mjs, promotes them to artist_links later).
// Idempotent — ignoreDuplicates on (artist_id, parsed_url). Shared by
// the full sync and --links-only. Returns { error } (null on success or
// when there's nothing to write).
// ------------------------------------------------------------
async function stageHarvestedLinks(supabaseClient, { artistId, scUrl, candidates }) {
  if (candidates.length === 0) return { error: null };
  return supabaseClient.from("artist_harvested_links").upsert(
    candidates.map((c) => ({
      artist_id: artistId,
      source_platform: "soundcloud",
      source_url: scUrl,
      raw_url: c.rawUrl,
      parsed_platform: c.platform,
      parsed_url: c.parsedUrl,
    })),
    { onConflict: "artist_id,parsed_url", ignoreDuplicates: true }
  );
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

    if (APPROVED_ONLY) {
      query = query.eq("artists.directory_status", "approved").eq("artists.deleted", false);
    }
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
// syncArtist — the single per-artist unit. Resolves one artist from
// SoundCloud and fans the result out to artist_enrichment (profile
// data + bio), biographies (cleaned bio, platform='soundcloud'),
// artist_images (avatar, approved artists only), and
// artist_harvested_links/artist_harvested_bios (staged links + raw
// bio). Returns a status object the CLI loop uses for its summary
// tallies; a future event-triggered caller (single artist, on
// approval) can call this directly and ignore the tallying.
//
// opts.artistIdsWithLinktree — a mutable Set<artist_id> the caller
// preloads once (see loadArtistIdsWithLinktreeLink) and passes in, so
// a run processing many artists doesn't re-query it per artist.
//
// opts.imageOnly — when true, fetches the user resource and does the
// image write ONLY, skipping playlists, web-profiles, and every
// bio/link write, and leaving resolved_artists('soundcloud-sync')
// untouched. For artists whose main sync already succeeded but who are
// missing a soundcloud artist_images row (typically: approved after
// their non-directory main sync already ran) — see main() and the
// module header's "Image handling" section.
//
// opts.linksOnly — when true, re-fetches ONLY the web-profiles "Links"
// section (from the stored numeric id, one API call, no /resolve) and
// re-stages the harvested links, skipping the user resource, bio,
// image, and playlists. Requires artist.scUserId. Touches no
// completion or failure state — a links refresh doesn't change
// main-sync completeness. See main()'s --links-only branch.
//
// artist.scUserId — the numeric SoundCloud user id from a prior sync
// (artist_enrichment.external_id, preloaded by main()). When present,
// the user resource is fetched by id instead of by resolving scUrl:
// skips /resolve and is immune to the artist renaming their profile
// URL (the id never changes). null/absent falls back to resolve-by-URL.
// ------------------------------------------------------------
export async function syncArtist(artist, opts = {}) {
  const {
    debug = false,
    dryRun = false,
    artistIdsWithLinktree = new Set(),
    imageOnly = false,
    linksOnly = false,
  } = opts;
  const { artistId, name, scUrl, scUserId = null, directoryStatus } = artist;
  const isApproved = directoryStatus === "approved";

  // Records a failure and, only for statuses that should stop being
  // retried automatically (today: just a definitive 404 — see the
  // module header for why wrong-field/transient/write failures are
  // deliberately NOT marked done), marks the artist processed. Every
  // failure branch below funnels through here instead of repeating
  // "recordFailure(...) [+ maybe markProcessed(...)]" at each call
  // site, so "which failures are permanent" is a single, visible
  // decision (the markDone flag) rather than five inline copies of
  // the same conditional.
  async function fail(status, { detail, markDone = false } = {}) {
    if (dryRun) return;
    if (markDone) await markProcessed(artistId);
    await recordFailure(supabase, { artistId, service: STATE_SERVICE, status, detail, url: scUrl });
  }

  // Same idea, for the image-only concern — a separate
  // harvest_failures service (IMAGE_STATE_SERVICE) so an image-only
  // failure never touches 'soundcloud-sync' state for an artist whose
  // main sync already succeeded. There's no resolved_artists row for
  // images (completion = an artist_images row existing), so there's
  // no markDone here; main()'s image-only candidate selection does
  // its own link-changed-since-failure cross-check against this
  // service instead.
  async function failImage(status, detail) {
    if (dryRun) return;
    await recordFailure(supabase, { artistId, service: IMAGE_STATE_SERVICE, status, detail, url: scUrl });
  }

  // -- Links-only refresh: re-fetch just the web-profiles "Links"
  // section from the stored id and re-stage harvested links. One API
  // call, no /resolve, and none of the user-resource/bio/image/playlist
  // work. Requires a stored id (an artist without one was never fully
  // synced, so there's nothing to refresh). Deliberately leaves
  // resolved_artists and harvest_failures untouched — a links refresh
  // doesn't change main-sync completeness, and there's no state to
  // un-stick later (the next --links-only run just retries), so
  // failures are logged + tallied only. --
  if (linksOnly) {
    if (!scUserId) {
      if (debug) console.log(`  [debug] ${name}: --links-only but no stored SoundCloud id — skipped`);
      return { status: "links_skipped_no_id" };
    }
    const urn = `soundcloud:users:${scUserId}`;
    const profilesRes = await sc.soundcloudGet(`/users/${encodeURIComponent(urn)}/web-profiles`);
    if (!profilesRes.ok || !Array.isArray(profilesRes.data)) {
      console.log(`✗ ${name}: links-only — web-profiles fetch failed (HTTP ${profilesRes.status ?? "timeout"})`);
      await sleep(300);
      return { status: "links_failed", httpStatus: profilesRes.status };
    }
    if (debug) console.log("  [debug] web-profiles raw:", JSON.stringify(profilesRes.data));
    const candidatesRaw = [];
    for (const p of profilesRes.data) {
      if (typeof p?.url === "string" && p.url.trim()) {
        candidatesRaw.push({ rawUrl: p.url.trim(), source: `web-profiles:${p.service ?? "?"}` });
      }
    }
    const candidates = buildCandidates(candidatesRaw);
    if (!dryRun && candidates.length > 0) {
      const { error: insertError } = await stageHarvestedLinks(supabase, { artistId, scUrl, candidates });
      if (insertError) {
        console.log(`✗ ${name}: links-only — artist_harvested_links upsert failed: ${insertError.message}`);
        await sleep(300);
        return { status: "links_failed" };
      }
    }
    const linksNote = candidates.length > 0 ? ` — ${candidates.map((c) => c.platform).join(", ")}` : "";
    console.log(`✓ ${name}: links-only — ${candidates.length} link(s)${linksNote}`);
    await sleep(300);
    return {
      status: "links_synced",
      linksFound: candidates.length,
      linksByPlatform: candidates.reduce((acc, c) => {
        acc[c.platform] = (acc[c.platform] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }

  // -- 1. Fetch the user resource (feeds both artist_enrichment and the
  // web-profiles/bio harvest below). With a stored numeric id from a
  // prior sync, fetch it directly by id (/users/{id}) — skips /resolve
  // and is immune to the artist renaming their profile URL. Only a
  // first-time sync (no stored id) resolves by URL, which is the sole
  // path where the wrong-field guard is meaningful: a stored id means
  // the URL already resolved cleanly once. --
  let res;
  if (scUserId) {
    if (debug) console.log(`  [debug] ${name}: fetching by stored id ${scUserId} (skipping /resolve)`);
    res = await sc.getUserById(scUserId);
  } else {
    if (debug) console.log(`  [debug] ${name}: resolving by URL (no stored id yet)`);
    // Wrong-field URL guard: skip before spending an API call. A stored
    // link whose domain isn't soundcloud.com (a data-entry mistake) can
    // never resolve.
    if (!isSoundCloudUrl(scUrl)) {
      console.log(`⚠ ${name}: skipped — stored URL is not a soundcloud.com link (${scUrl})`);
      if (imageOnly) {
        await failImage(IMAGE_FAILURE_STATUS.UNREACHABLE, "stored soundcloud link does not resolve to a soundcloud.com domain");
        return { status: "skipped_wrong_field" };
      }
      // Marked processed, same reasoning as a 404: a domain mismatch
      // doesn't fix itself on retry, so recording a fresh
      // harvest_failures row for it every single run forever is pure
      // waste. main()'s loadFailureUrls cross-check un-sticks this
      // artist automatically once a human corrects the link.
      await fail("wrong_field_url", {
        detail: "stored soundcloud link does not resolve to a soundcloud.com domain",
        markDone: true,
      });
      return { status: "skipped_wrong_field" };
    }
    res = await sc.resolveUser(scUrl);
  }

  // Stored-id 404 fallback: a definitive 404 means the id itself is
  // stale (the account was deleted/recreated), but the current link may
  // now point at a live account — resolve it once so an account move
  // recovers automatically, the same way --force used to before the
  // fetch-by-id change. Only for a 404 (transient failures just retry
  // next run) and only when the URL is a real soundcloud.com link.
  if (scUserId && !res.ok && res.status === 404 && isSoundCloudUrl(scUrl)) {
    if (debug) console.log(`  [debug] ${name}: stored id ${scUserId} returned 404, falling back to resolve-by-URL`);
    res = await sc.resolveUser(scUrl);
  }

  if (!res.ok || !res.data) {
    console.log(`✗ ${name}: resolve failed (HTTP ${res.status ?? "timeout"})`);
    if (imageOnly) {
      if (res.status === 404) {
        await failImage(IMAGE_FAILURE_STATUS.UNREACHABLE, "resolve returned 404 (dead link)");
      } else {
        await failImage(IMAGE_FAILURE_STATUS.FETCH_FAILED, `resolve failed (HTTP ${res.status ?? "timeout"})`);
      }
      await sleep(300);
      return { status: "failed_resolve", httpStatus: res.status };
    }
    if (res.status === 404) {
      // Definitive dead link — mark processed so it doesn't retry
      // forever; main()'s loadFailureUrls cross-check un-sticks it
      // again if the link is later corrected.
      await fail("resolve_404", { detail: "resolve returned 404 (dead link)", markDone: true });
    } else {
      // Transient — timeouts, rate limits, other HTTP errors. Left
      // unmarked so the next run retries automatically (no link-change
      // detection needed, since it was never marked done in the first
      // place).
      await fail("resolve_failed", { detail: `resolve failed (HTTP ${res.status ?? "timeout"})` });
    }
    await sleep(300);
    return { status: "failed_resolve", httpStatus: res.status };
  }

  const user = res.data;
  const urn = user.urn ?? (user.id != null ? `soundcloud:users:${user.id}` : null);

  if (debug) {
    console.log(
      `  [debug] ${name}: followers=${user.followers_count} tracks=${user.track_count} ` +
        `avatar=${user.avatar_url ?? "(none)"}`
    );
  }

  // -- Image write: artist_images (artist_id, platform='soundcloud'),
  // approved artists only, regardless of what scoped this call. Done
  // for both the full sync and the image-only path — one /resolve
  // call already got us the avatar either way, so there's no reason
  // to defer it.
  let imageStatus = "not_approved";
  if (isApproved) {
    const avatarUrl = upgradeAvatarUrl(user.avatar_url);
    if (!avatarUrl) {
      // No avatar at all — nothing to store. Recorded like any other
      // image failure so the image-only pass stops re-resolving this
      // artist every run (a wasted /resolve call). Same URL-keyed
      // trade-off as default_avatar below: an avatar added later at the
      // unchanged profile URL is only picked up on --force (or if the
      // link changes), not automatically.
      imageStatus = "no_avatar";
      if (debug) console.log(`  [debug] ${name}: approved but no avatar_url on resolved user`);
      await failImage(IMAGE_FAILURE_STATUS.NO_IMAGE, "resolved soundcloud user has no avatar_url");
    } else if (isDefaultAvatarUrl(user.avatar_url)) {
      // SoundCloud serves a generic placeholder avatar for accounts with
      // no real photo — not a usable image, so don't re-host a silhouette.
      // Record it against IMAGE_STATE_SERVICE (with the current profile
      // URL) so main()'s image-only pass stops re-attempting until the
      // link changes — the same link-changed-since-failure cross-check it
      // already applies to every other image failure.
      imageStatus = "default_avatar";
      if (debug) console.log(`  [debug] ${name}: approved but avatar_url is SoundCloud's default placeholder`);
      await failImage(IMAGE_FAILURE_STATUS.PLACEHOLDER, "soundcloud returned its default placeholder avatar (no real photo)");
    } else if (!dryRun) {
      const { error: imageError } = await supabase.from("artist_images").upsert(
        {
          artist_id: artistId,
          platform: "soundcloud",
          source_url: avatarUrl,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "artist_id,platform" }
      );
      if (imageError) {
        console.error(`  failed to save soundcloud image: ${imageError.message}`);
        imageStatus = "failed";
        await failImage(IMAGE_FAILURE_STATUS.WRITE_FAILED, `artist_images upsert failed: ${imageError.message}`);
      } else {
        imageStatus = "stored";
        await clearFailure(supabase, { artistId, service: IMAGE_STATE_SERVICE });
      }
    } else {
      imageStatus = "stored"; // dry run — would have stored
    }
  }

  if (imageOnly) {
    // Stop here — playlists/web-profiles/bio/links are already done
    // from the main sync; resolved_artists('soundcloud-sync') is left
    // untouched since this call was never about the main sync.
    console.log(
      `${imageStatus === "stored" ? "✓" : imageStatus === "no_avatar" || imageStatus === "default_avatar" ? "○" : "✗"} ${name}: image-only — ${imageStatus}`
    );
    await sleep(300);
    return { status: imageStatus === "stored" ? "image_synced" : "image_failed", imageStatus };
  }

  // -- 2. Zero uploads: fall back to the account's playlists (sets) --
  // No public API endpoint for a user's reposts, so this is the best
  // available substitute for "what can we embed for them."
  let playlists = null;
  if (user.track_count === 0 && user.id != null) {
    const playlistsRes = await sc.soundcloudGet(
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
      if (debug) console.log(`  [debug] ${name}: 0 tracks, found ${playlists.length} playlist(s)`);
    } else if (debug) {
      console.log(`  [debug] ${name}: playlists fetch failed (HTTP ${playlistsRes.status ?? "timeout"})`);
    }
    await sleep(300);
  }

  // -- 3. web-profiles (the "Links" section) --
  const candidatesRaw = [];
  if (urn) {
    const profilesRes = await sc.soundcloudGet(`/users/${encodeURIComponent(urn)}/web-profiles`);
    if (profilesRes.ok && Array.isArray(profilesRes.data)) {
      if (debug) console.log("  [debug] web-profiles raw:", JSON.stringify(profilesRes.data));
      for (const p of profilesRes.data) {
        if (typeof p?.url === "string" && p.url.trim()) {
          candidatesRaw.push({ rawUrl: p.url.trim(), source: `web-profiles:${p.service ?? "?"}` });
        }
      }
    } else if (debug) {
      console.log(`  [debug] web-profiles fetch failed (status ${profilesRes.status})`);
    }
  } else if (debug) {
    console.log("  [debug] no urn on resolved user, skipping web-profiles");
  }

  // -- 4. Raw bio text — kept unconditionally (audit trail) and also
  // scanned for gate.sc / plain URLs to known platforms --
  const rawBio =
    typeof user.description === "string" && user.description.trim()
      ? user.description.trim()
      : null;

  if (rawBio) {
    for (const target of extractGateScTargets(rawBio)) {
      candidatesRaw.push({ rawUrl: target, source: "bio:gate.sc" });
    }
    for (const plain of extractPlainUrls(rawBio)) {
      if (/gate\.sc/i.test(plain)) continue;
      candidatesRaw.push({ rawUrl: plain, source: "bio:plain" });
    }
  }

  const candidates = buildCandidates(candidatesRaw);

  // -- 5. Parse the bio through the cleanup pipeline for the LIVE
  // artist_enrichment.bio field (booking/management/contact/linktree
  // extraction) — same pipeline as the old enrich-soundcloud.mjs.
  // Generic/boilerplate descriptions are skipped for this cleaned
  // path, but still preserved as-is in rawBio above. --
  let bio = null;
  let booking = null;
  let management = null;
  let contact = null;
  let linktreeUrl = null;

  if (rawBio && !isGenericDescription(rawBio)) {
    const decoded = decodeEntities(rawBio);
    const decodedGateSc = decodeGateSc(decoded);
    const { text: withoutLinktree, linktreeUrl: lt } = extractLinktree(decodedGateSc);
    linktreeUrl = lt;
    const parsed = parseDescription(withoutLinktree);
    bio = parsed.bio;
    booking = parsed.booking;
    management = parsed.management;
    contact = parsed.contact;
  }

  // -- 6. Writes --
  let writeFailed = false;
  let writeFailDetail = null;

  if (!dryRun) {
    const { error: enrichError } = await supabase.from("artist_enrichment").upsert(
      {
        artist_id: artistId,
        platform: "soundcloud",
        external_id: user.id != null ? String(user.id) : null,
        // Image lives in artist_images now (written above), not here —
        // explicitly nulled (not omitted) so a stale pre-migration
        // value doesn't sit around looking authoritative.
        profile_image_url: null,
        bio: bio ? `SoundCloud bio: ${bio}` : bio,
        follower_count: user.followers_count ?? null,
        track_count: user.track_count ?? null,
        recent_tracks: null,
        playlists,
        last_synced_at: new Date().toISOString(),
        sync_error: null,
      },
      { onConflict: "artist_id,platform" }
    );

    if (enrichError) {
      console.log(`✗ ${name}: artist_enrichment upsert failed — ${enrichError.message}`);
      // Not marked processed — same reasoning as resolve_failed: a DB
      // write error is presumed transient, so retry every run.
      await fail("write_failed", { detail: `artist_enrichment upsert failed: ${enrichError.message}` });
      await sleep(300);
      return { status: "failed_write" };
    }

    // Raw /resolve payload → api_response_cache (namespace 'soundcloud_user',
    // cache_key = artist_id), not artist_enrichment.raw_data (that column was
    // dropped — see supabase_migration_move_raw_data_to_cache.sql). Best-effort
    // archival: the blob is re-fetchable, so a write error here is logged but
    // doesn't fail the sync or block marking the artist processed.
    const { error: cacheError } = await supabase.from("api_response_cache").upsert(
      {
        namespace: "soundcloud_user",
        cache_key: String(artistId),
        payload: user,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "namespace,cache_key" }
    );
    if (cacheError) {
      console.error(`  ${name}: raw_data cache write failed (non-fatal): ${cacheError.message}`);
    }

    // Booking/management/contact — best-effort, doesn't fail the sync.
    if (booking || management || contact) {
      const update = {};
      if (booking) update.booking_info = booking;
      if (management) update.management_info = management;
      if (contact) update.contact_info = contact;
      const { error: artistUpdateError } = await supabase.from("artists").update(update).eq("id", artistId);
      if (artistUpdateError) {
        console.error(`  failed to save booking/management/contact: ${artistUpdateError.message}`);
      }
    }

    // Linktree URL found in the bio — added to artist_links (same as a
    // harvested link) unless the artist already has one.
    if (linktreeUrl && !artistIdsWithLinktree.has(artistId)) {
      const { error: linktreeError } = await supabase
        .from("artist_links")
        .upsert(
          { artist_id: artistId, platform: "linktree", url: linktreeUrl },
          { onConflict: "artist_id,platform", ignoreDuplicates: true }
        );
      if (linktreeError) {
        console.error(`  failed to save linktree link: ${linktreeError.message}`);
      } else {
        artistIdsWithLinktree.add(artistId);
      }
    }

    // Staged links (web-profiles + bio URLs).
    if (candidates.length > 0) {
      const { error: insertError } = await stageHarvestedLinks(supabase, { artistId, scUrl, candidates });
      if (insertError) {
        console.error(`  failed to save harvested links: ${insertError.message}`);
        writeFailed = true;
        writeFailDetail = `artist_harvested_links upsert failed: ${insertError.message}`;
      }
    }

    // Raw bio audit trail.
    if (rawBio) {
      const { error: bioError } = await supabase.from("artist_harvested_bios").upsert(
        {
          artist_id: artistId,
          source_platform: "soundcloud",
          source_url: scUrl,
          raw_bio: rawBio,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "artist_id,source_platform" }
      );
      if (bioError) {
        console.error(`  failed to save raw bio: ${bioError.message}`);
        writeFailed = true;
        writeFailDetail = writeFailDetail
          ? `${writeFailDetail}; artist_harvested_bios upsert failed: ${bioError.message}`
          : `artist_harvested_bios upsert failed: ${bioError.message}`;
      }
    }

    // Cleaned, display-ready bio → biographies (platform='soundcloud'), the
    // one-bio-per-artist-per-platform home. Same pattern as sync-discogs: the
    // raw text stays in artist_harvested_bios (above) as an audit trail, the
    // parsed text lands here. No "SoundCloud bio:" prefix — platform is its own
    // column here (unlike the shared artist_enrichment.bio field). Only written
    // when we have a non-generic parsed bio; a generic description leaves the
    // seeded backfill row untouched.
    if (bio) {
      const { error: biographyError } = await supabase.from("biographies").upsert(
        {
          artist_id: artistId,
          platform: "soundcloud",
          bio,
          source_url: scUrl,
        },
        { onConflict: "artist_id,platform" }
      );
      if (biographyError) {
        console.error(`  failed to save biography: ${biographyError.message}`);
        writeFailed = true;
        writeFailDetail = writeFailDetail
          ? `${writeFailDetail}; biographies upsert failed: ${biographyError.message}`
          : `biographies upsert failed: ${biographyError.message}`;
      }
    }

    if (writeFailed) {
      // Not marked processed — retry every run, same as above.
      await fail("write_failed", { detail: writeFailDetail });
    } else {
      await markProcessed(artistId);
      await clearFailure(supabase, { artistId, service: STATE_SERVICE });
    }
  }

  const followers = user.followers_count != null ? user.followers_count.toLocaleString() : "?";
  const playlistsNote = playlists ? `, ${playlists.length} playlist(s) as fallback` : "";
  const linksNote =
    candidates.length > 0 ? `, ${candidates.length} link(s) — ${candidates.map((c) => c.platform).join(", ")}` : "";
  const bioPreview = rawBio ? `"${rawBio.slice(0, 60)}${rawBio.length > 60 ? "…" : ""}"` : "(no bio)";
  console.log(
    `✓ ${name}: ${followers} followers, ${user.track_count ?? "?"} tracks${playlistsNote}${linksNote}, ${bioPreview}`
  );

  await sleep(300);

  return {
    status: writeFailed ? "failed_write" : "synced",
    linksFound: candidates.length,
    linksByPlatform: candidates.reduce((acc, c) => {
      acc[c.platform] = (acc[c.platform] ?? 0) + 1;
      return acc;
    }, {}),
    hasBio: Boolean(rawBio),
    imageStatus,
  };
}

// ------------------------------------------------------------
// Failures CSV — written at the end of every run (see writeFailuresCsv
// below). csvCell()/timestamp() match the convention already used by
// other-links-domain-counts.mjs for exactly this kind of report.
// ------------------------------------------------------------
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// ------------------------------------------------------------
// Writes a CSV snapshot of every current soundcloud-sync row in
// harvest_failures — one per artist still unresolved as of this run
// (cleared rows, from artists that have since succeeded, don't
// appear). Written every run, DRY_RUN or not, since it reflects
// whatever's actually in the table rather than what this run did.
//
// Columns: artist_name, rebalance_gender_url (the artist's live page
// on the site, so a reviewer can click straight through), status, url
// (the SoundCloud link that failed), occurred_at.
//
// Saved one level up from this repo (the "Rebalance Gender" folder,
// not inside rebalance-gender-repo — same convention as
// other-links-domain-counts.mjs) with a datetime in the filename, so
// re-running never overwrites a previous run's report.
// ------------------------------------------------------------
async function writeFailuresCsv() {
  const PAGE_SIZE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("harvest_failures")
      .select("artist_id, status, url, occurred_at, artists(name)")
      .eq("service", STATE_SERVICE)
      .order("status", { ascending: true })
      .order("occurred_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const header = ["artist_name", "rebalance_gender_url", "status", "url", "occurred_at"];
  const csv =
    [header.join(",")]
      .concat(
        rows.map((r) =>
          [
            csvCell(r.artists?.name ?? r.artist_id),
            csvCell(`${SITE_URL}/artist/${r.artist_id}`),
            csvCell(r.status),
            csvCell(r.url),
            csvCell(r.occurred_at),
          ].join(",")
        )
      )
      .join("\n") + "\n";

  const outDir = path.resolve(__dirname, "..", "..");
  const outPath = path.join(outDir, `sync-soundcloud-failures-${timestamp()}.csv`);
  fs.writeFileSync(outPath, csv);
  console.log(`\nWrote ${rows.length} current failure(s) to ${outPath}`);
}

// ------------------------------------------------------------
// Main (CLI entry) — a thin loop over syncArtist().
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running SoundCloud sync\n");
  if (APPROVED_ONLY) console.log("--approved: restricting to directory artists (directory_status = 'approved')\n");
  if (STATUS_FILTER) console.log(`Filtering by directory_status: ${STATUS_FILTER}\n`);

  await sc.getAccessToken();
  console.log("SoundCloud API token acquired.\n");

  // --links-only: refresh just the web-profiles "Links" section for
  // every matching artist that has a stored id — one API call each, no
  // /resolve. Ignores resolved_artists state (a refresh is meant to
  // re-run) and touches no completion/failure state; see syncArtist's
  // linksOnly branch. Respects --approved / --name / --status / --limit
  // via the same fetchAllSoundCloudLinks() the normal path uses.
  if (LINKS_ONLY) {
    const matchingLinks = await fetchAllSoundCloudLinks();
    // Resolve stored ids in chunks and keep only the artists that have
    // one, short-circuiting once LIMIT rows are collected — a bare
    // --limit test run shouldn't scan every matching artist's
    // enrichment row just to throw most away.
    const CHUNK = 500;
    const idMap = new Map();
    const linkRows = [];
    let scanned = 0;
    for (let i = 0; i < matchingLinks.length && (!LIMIT || linkRows.length < LIMIT); i += CHUNK) {
      const batch = matchingLinks.slice(i, i + CHUNK);
      const batchMap = await fetchScUserIdsForArtists(batch.map((r) => r.artist_id));
      for (const row of batch) {
        scanned++;
        const id = batchMap.get(row.artist_id);
        if (!id) continue;
        idMap.set(row.artist_id, id);
        linkRows.push(row);
        if (LIMIT && linkRows.length >= LIMIT) break;
      }
    }
    const skippedNoId = scanned - linkRows.length;
    console.log(
      `--links-only: refreshing ${linkRows.length} artist(s) with a stored SoundCloud id` +
        (skippedNoId > 0 ? ` (${skippedNoId} of ${scanned} scanned had none — never fully synced)` : "") +
        "\n"
    );

    let attempted = 0;
    let linksSynced = 0;
    let linksFailed = 0;
    let totalLinksFound = 0;
    const byPlatform = {};
    for (const row of linkRows) {
      const name = row.artists?.name ?? row.artist_id;
      attempted++;
      const result = await syncArtist(
        {
          artistId: row.artist_id,
          name,
          scUrl: row.url,
          scUserId: idMap.get(row.artist_id) ?? null,
          directoryStatus: row.artists?.directory_status,
        },
        { debug: DEBUG, dryRun: DRY_RUN, linksOnly: true }
      );
      if (result.status === "links_synced") {
        linksSynced++;
        totalLinksFound += result.linksFound ?? 0;
        for (const [platform, count] of Object.entries(result.linksByPlatform ?? {})) {
          byPlatform[platform] = (byPlatform[platform] ?? 0) + count;
        }
      } else if (result.status === "links_failed") {
        linksFailed++;
      }
    }

    console.log(`\nDone${DRY_RUN ? " (dry run)" : ""} (links-only).`);
    console.log(`  attempted:         ${attempted}`);
    console.log(`  ${DRY_RUN ? "would refresh" : "refreshed"}:  ${linksSynced}`);
    console.log(`  failed:            ${linksFailed}`);
    console.log(`  total links found: ${totalLinksFound}`);
    for (const [platform, count] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${platform}: ${count}`);
    }
    return;
  }

  const processed = FORCE ? new Set() : await loadProcessedArtistIds();
  if (FORCE) {
    console.log("--force: bypassing resolved_artists state\n");
  } else if (processed.size > 0) {
    console.log(
      `State loaded: ${processed.size} artist(s) already processed (resolved_artists; pass --force to bypass)\n`
    );
  }

  const artistIdsWithLinktree = await loadArtistIdsWithLinktreeLink();
  const artistIdsWithSoundcloudImage = await fetchArtistIdsWithSoundcloudImage();

  const links = await fetchAllSoundCloudLinks();

  let rows = links;
  let imageOnlyRows = [];
  let skippedProcessed = 0;
  let retriedLinkChanged = 0;
  if (!FORCE) {
    // Two failure statuses mark an artist processed (see syncArtist's
    // fail() helper, markDone): resolve_404 and wrong_field_url. Both
    // would otherwise skip the artist forever even after a human fixes
    // the stored link — resolved_artists only knows "done for this
    // artist_id", not which URL was checked. Cross-reference the URL
    // harvest_failures recorded at failure time against the current
    // artist_links row: if they differ, the link was fixed since, so
    // retry it instead of requiring --force (which would reprocess
    // every artist). No status filter here — any status that reaches
    // this map is one syncArtist chose to mark done, so all of them
    // get the same treatment automatically as new ones are added.
    const failedUrls = await loadFailureUrls(supabase, { service: STATE_SERVICE });
    // Same cross-check, for the image-only concern's own failure
    // service — see "Image handling" in the module header.
    const imageFailedUrls = await loadFailureUrls(supabase, { service: IMAGE_STATE_SERVICE });

    const remaining = [];
    for (const row of links) {
      if (processed.has(row.artist_id)) {
        const failedUrl = failedUrls.get(row.artist_id);
        if (failedUrl && failedUrl !== row.url) {
          remaining.push(row);
          retriedLinkChanged++;
          continue;
        }
        if (failedUrl) {
          // Still a matching, unresolved main-sync failure — link
          // hasn't changed since. Excluded from everything, same as
          // before a human fixes it.
          skippedProcessed++;
          continue;
        }
        // Genuinely synced already (no current main-sync failure).
        // Still eligible for the lighter image-only path if approved
        // and missing a soundcloud image — directory-only for images
        // holds regardless of what scoped this run.
        const isApproved = row.artists?.directory_status === "approved";
        const hasImage = artistIdsWithSoundcloudImage.has(row.artist_id);
        if (isApproved && !hasImage) {
          const imageFailedUrl = imageFailedUrls.get(row.artist_id);
          if (imageFailedUrl && imageFailedUrl === row.url) {
            // Same URL already failed the image-only path (e.g. a 404
            // discovered only once we tried the image) — don't keep
            // re-attempting until the link changes.
            skippedProcessed++;
          } else {
            imageOnlyRows.push(row);
          }
        } else {
          skippedProcessed++;
        }
      } else {
        remaining.push(row);
      }
    }
    rows = remaining;
  }
  if (LIMIT) {
    rows = rows.slice(0, LIMIT);
    imageOnlyRows = imageOnlyRows.slice(0, LIMIT);
  }

  // Stored SoundCloud ids for just the artists this run will process
  // (main sync + image-only). Re-runs fetch the user resource by id
  // instead of re-resolving the profile URL — scoped to the working
  // set, never the whole enrichment table.
  const scUserIdByArtist = await fetchScUserIdsForArtists(
    [...rows, ...imageOnlyRows].map((r) => r.artist_id)
  );

  console.log(
    `Found ${links.length} SoundCloud link(s)` +
      (skippedProcessed > 0 ? `, ${skippedProcessed} already processed (skipped)` : "") +
      (retriedLinkChanged > 0 ? `, ${retriedLinkChanged} retried (link changed since a prior failure)` : "") +
      `${LIMIT ? `, processing next ${rows.length}` : ""}\n`
  );
  if (imageOnlyRows.length > 0) {
    console.log(
      `${imageOnlyRows.length} already-synced approved artist(s) missing a soundcloud image — running the lighter image-only pass for them.\n`
    );
  }

  let attempted = 0;
  let synced = 0;
  let skippedWrongField = 0;
  let failedResolve = 0;
  let failedWrite = 0;
  let totalLinksFound = 0;
  let biosFound = 0;
  let imagesStored = 0;
  const byPlatform = {};

  for (const row of rows) {
    const name = row.artists?.name ?? row.artist_id;
    attempted++;

    const result = await syncArtist(
      {
        artistId: row.artist_id,
        name,
        scUrl: row.url,
        scUserId: scUserIdByArtist.get(row.artist_id) ?? null,
        directoryStatus: row.artists?.directory_status,
      },
      { debug: DEBUG, dryRun: DRY_RUN, artistIdsWithLinktree }
    );

    switch (result.status) {
      case "synced":
        synced++;
        totalLinksFound += result.linksFound ?? 0;
        if (result.hasBio) biosFound++;
        if (result.imageStatus === "stored") imagesStored++;
        for (const [platform, count] of Object.entries(result.linksByPlatform ?? {})) {
          byPlatform[platform] = (byPlatform[platform] ?? 0) + count;
        }
        break;
      case "skipped_wrong_field":
        skippedWrongField++;
        break;
      case "failed_resolve":
        failedResolve++;
        break;
      case "failed_write":
        failedWrite++;
        break;
    }
  }

  let imageOnlyAttempted = 0;
  let imageOnlyFailed = 0;
  for (const row of imageOnlyRows) {
    const name = row.artists?.name ?? row.artist_id;
    imageOnlyAttempted++;

    const result = await syncArtist(
      {
        artistId: row.artist_id,
        name,
        scUrl: row.url,
        scUserId: scUserIdByArtist.get(row.artist_id) ?? null,
        directoryStatus: row.artists?.directory_status,
      },
      { debug: DEBUG, dryRun: DRY_RUN, imageOnly: true }
    );

    if (result.status === "image_synced") {
      imagesStored++;
    } else {
      imageOnlyFailed++;
    }
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  attempted:              ${attempted}`);
  console.log(`  skipped (processed):    ${skippedProcessed}`);
  if (retriedLinkChanged > 0) {
    console.log(`  retried (link changed): ${retriedLinkChanged}`);
  }
  console.log(`  skipped (wrong field):  ${skippedWrongField}`);
  console.log(`  resolve failed:         ${failedResolve}`);
  console.log(`  write failed:           ${failedWrite}`);
  console.log(`  ${DRY_RUN ? "would sync" : "synced"}:                ${synced}`);
  console.log(`  total links found:      ${totalLinksFound}`);
  for (const [platform, count] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${platform}: ${count}`);
  }
  console.log(`  bios found:             ${biosFound}`);
  if (imageOnlyAttempted > 0) {
    console.log(`  image-only attempted:   ${imageOnlyAttempted}`);
    console.log(`  image-only failed:      ${imageOnlyFailed}`);
  }
  console.log(`  images stored:          ${imagesStored}`);

  await writeFailuresCsv();
}

main().catch((err) => {
  console.error("\nSync failed:", err?.message ?? err);
  process.exit(1);
});
