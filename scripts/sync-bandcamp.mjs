#!/usr/bin/env node
// ============================================================
// Bandcamp sync: the merged Phase 6 Bandcamp stage.
//
// Replaces enrich-bandcamp.mjs (discography only). Follows the same
// "one fetch, fan out to every concern" pattern sync-soundcloud.mjs
// established for SoundCloud: a single request to an artist's
// Bandcamp page is parsed for everything that page can offer —
//
//   GET {core url}/music  (falls back to {core url} only if /music
//   itself fails to load — a successful-but-empty /music response,
//   e.g. shape #2 below, is accepted as-is rather than treated as a
//   reason to keep probing)
//     -> discography (album/track grid)      -> artist_bandcamp_albums
//     -> bio text (#bio-text)                -> artist_enrichment.bio
//                                                + biographies
//                                                  (platform='bandcamp')
//                                                + artist_harvested_bios
//                                                  (raw audit trail)
//     -> location (#band-name-location .location) -> artist_locations
//        (only written when the artist has no existing row — never
//        clobbers a manually-entered location)
//     -> band photo (#pic-container popup image, falling back to
//        og:image only when we've confirmed og:type=band — see
//        "Image handling" below) -> artist_images (platform='bandcamp')
//     -> external links sidebar (#band-links)  -> artist_harvested_links
//        (staged, never written directly to artist_links — same
//        contract as every other harvester; integrate-harvested-
//        links.mjs / harvest-links-loop.mjs promotes it)
//     -> genre tags (release pages only, .tag anchors) -> artist_harvested_genres
//
// No API key required — same as enrich-bandcamp.mjs, this is a plain
// HTML scrape. Selectors are based on Bandcamp's documented page
// structure (the same #bio-container / #band-links / .tag markup
// bandcamp-scraper and similar tools rely on) — NOT verified against
// live HTML from this development environment, whose sandbox network
// egress is restricted (outbound fetches to bandcamp.com are blocked
// by the proxy allowlist here; browsing Bandcamp for the page-shape
// research behind this script had to go through a read-only fetch
// tool that strips the raw DOM down to visible text). Before a bulk
// run, sanity-check with:
//
//   DRY_RUN=1 node scripts/sync-bandcamp.mjs --debug --limit=5
//
// and spot-check the four page shapes below by name/URL.
//
// Four page shapes, all handled by the same fetch + regex-scrape
// (Bandcamp reuses the same bio-container partial across all of
// them, so no shape-specific branching is needed beyond what's
// naturally implied by which regexes match):
//
//   1. Full artist page, has releases — {sub}.bandcamp.com/music
//      shows the music grid AND the bio sidebar. Everything above is
//      harvested. Example: erikagluck.bandcamp.com
//   2. Bio-only page, no releases — {sub}.bandcamp.com/music returns
//      200 on the SAME path (no redirect) but the grid is empty.
//      Bio/location/links are still harvested if present; no
//      artist_bandcamp_albums rows are written. Example:
//      silvielotoofficial.bandcamp.com
//   3. Redirects to a track — {sub}.bandcamp.com (and /music) 302s
//      to /track/{slug} when the artist has exactly one piece of
//      content and nothing else. The track page carries the same
//      bio-container partial in its sidebar, so bio/location/links
//      are still harvested; there's no grid to draw a discography
//      from. og:image on this page is the TRACK's artwork, not the
//      artist's photo — see "Image handling" below for why that's
//      not used as the profile image. Example: skyla-techno.bandcamp.com
//   4. Redirects to a merch item — same shape as #3 but landing on
//      /merch/{slug} instead of a track. Example:
//      laurencematte.bandcamp.com
//
// A fifth shape is NOT a valid artist page and is rejected before any
// fetch (see the wrong-field guard below): a bare bandcamp.com URL
// with no artist subdomain, e.g. a saved search link —
// bandcamp.com/search?q=msjy. There is nothing on that page to
// harvest for a specific artist; catching it before a fetch avoids
// wasting a request on it, the same reasoning sync-soundcloud.mjs
// applies to a wrong-field SoundCloud URL.
//
// Image handling: sync-bandcamp.mjs writes the raw discovered image
// URL to artist_images (artist_id, platform='bandcamp') — see
// supabase_migration_artist_images.sql — and does NOT re-host it to
// Storage itself. Re-hosting is store-images.mjs's job (Phase 5b): it
// walks every artist_images row lacking a storage_url, downloads it,
// and uploads it to artist-images/{artist_id}/bandcamp.{ext}. An
// artist can hold images from several platforms at once now (this one
// plus, say, SoundCloud's) rather than one platform's pick silently
// overwriting another's — see scripts/PIPELINE.md, "Multi-image
// artist_images table". This script never writes to
// artist_enrichment.profile_image_url (explicitly nulled in that
// upsert instead, so a pre-migration value doesn't linger looking
// authoritative).
//
// On a redirected track/merch page (shapes #3 and #4), og:image is
// the release/product's artwork, not a photo of the artist — using it
// as a profile image would put a T-shirt photo on an artist's page.
// The band photo in #pic-container (a distinct element from any
// release artwork, present in the shared bio-container partial
// regardless of which page we land on) is preferred; og:image is only
// used as a profile-image fallback when og:type is confirmed to be
// "band" (i.e. we're actually looking at the artist's own /music
// page, not a redirect).
//
// Not harvested, deliberately:
//   - Fan/supporter counts. Bandcamp loads these via a separate
//     client-side API call, not server-rendered into the page HTML
//     this script fetches — nothing reliable to scrape statically,
//     so (unlike SoundCloud's follower_count) this is left null
//     rather than shipping a field that would silently always be
//     empty.
//   - Release credits/about text. Captured opportunistically into
//     the archived page blob (api_response_cache, namespace
//     'bandcamp_page') when a redirected track/album page happens to
//     have it, but not promoted to a first-class column — flagged as a
//     future collaboration-signal enhancement, same status Discogs'
//     members/groups fields have in PIPELINE.md.
//
// Wrong-field URL guard: before fetching, the stored artist_links.url
// is checked against the *.bandcamp.com pattern (rejecting both
// non-Bandcamp URLs and the bare bandcamp.com apex — see shape #5
// above). A mismatch is skipped without a fetch and logged to
// harvest_failures, marked processed (a mismatch doesn't fix itself
// on retry) — same treatment as sync-soundcloud.mjs's SoundCloud-host
// guard.
//
// Failure persistence: every fetch/write failure is recorded in
// harvest_failures (service = 'bandcamp-sync') via
// scripts/lib/harvest-failures.mjs, cleared on a later success. A
// definitive dead link (404/410, or a redirect off Bandcamp entirely)
// marks the artist processed; other failures (timeouts, transient
// HTTP errors, DB write errors) are left unmarked so the next run
// retries automatically. Same link-changed-since-failure cross-check
// as sync-soundcloud.mjs: a 404/invalid-url-marked artist whose
// stored link has since been corrected is retried without --force.
//
// Processed state: resolved_artists, service = 'bandcamp-sync' — a
// fresh service name. The old enrich-bandcamp.mjs never used
// resolved_artists (it inferred "already done" from the presence of
// artist_bandcamp_albums rows), so there's no prior state to backfill.
//
// Directory-only by default, same as the script this replaces: only
// artists with directory_status = 'approved' (and not deleted) are
// processed. There is no way to opt out of that filter; --approved is
// accepted as a harmless no-op so the orchestrator can forward it
// uniformly across every stage.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/sync-bandcamp.mjs                  # all approved artists with a Bandcamp link
//   node scripts/sync-bandcamp.mjs --limit=20        # next 20 unprocessed (for testing)
//   node scripts/sync-bandcamp.mjs --force           # re-process even artists with existing state
//   node scripts/sync-bandcamp.mjs --name=erika      # filter source artists by name
//   node scripts/sync-bandcamp.mjs --debug           # log every parse decision
//   DRY_RUN=1 node scripts/sync-bandcamp.mjs         # fetch + log, don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordFailure, clearFailure, loadFailureUrls } from "./lib/harvest-failures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DEBUG = args.includes("--debug");
// Accepted as a no-op — see module header, "Directory-only by default".
args.includes("--approved");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

const STATE_SERVICE = "bandcamp-sync"; // resolved_artists.service / harvest_failures.service value

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
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rebalance-gender.app";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Processed-state tracking via resolved_artists (DB), not a cache
// file — project convention (see scripts/lib/harvest-failures.mjs
// and sync-soundcloud.mjs for the pattern this mirrors).
// ------------------------------------------------------------
const STATE_PAGE_SIZE = 1000;

async function loadProcessedArtistIds() {
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
// Artists that already have a manually-entered (or previously
// harvested) location, preloaded once so a Bandcamp location is only
// written when the artist doesn't already have one — never clobbers
// existing data. Same pattern sync-soundcloud.mjs uses for Linktree.
// ------------------------------------------------------------
async function loadArtistIdsWithLocation() {
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("artist_locations")
      .select("artist_id")
      .order("artist_id", { ascending: true })
      .range(from, from + STATE_PAGE_SIZE - 1);
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.artist_id);
    if ((data?.length ?? 0) < STATE_PAGE_SIZE) break;
    from += STATE_PAGE_SIZE;
  }
  return ids;
}

// ------------------------------------------------------------
// Wrong-field / invalid-URL guard — cheap pre-check before spending a
// fetch. A valid Bandcamp artist page always lives on a *subdomain* of
// bandcamp.com (never the bare apex, which is Bandcamp's own site —
// search results, login, etc.). See module header, shape #5.
// ------------------------------------------------------------
function isBandcampArtistUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host !== "bandcamp.com" && host.endsWith(".bandcamp.com");
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Strip a leading "www." from a Bandcamp artist URL. Bandcamp serves
// every artist from a bare subdomain (foo.bandcamp.com) and 301s the
// www. variant to it; Firefox flags the www. host as a potential
// security risk. We normalize before fetching and before recording the
// URL as a source_url so we never store or chase the www. form. A
// string replace (not new URL().toString()) is used so the rest of the
// URL — and the no-trailing-slash convention — is left exactly as-is.
// The subdomain is required in the pattern so the bare bandcamp.com
// apex (www.bandcamp.com) is left untouched for isBandcampArtistUrl to
// reject.
// ------------------------------------------------------------
function stripBandcampWww(rawUrl) {
  return rawUrl.replace(
    /^(https?:\/\/)www\.([a-z0-9-]+\.bandcamp\.com)/i,
    "$1$2"
  );
}

// ------------------------------------------------------------
// HTML parsing
//
// Discography grid — unchanged from enrich-bandcamp.mjs. Bandcamp
// music-grid items look like:
//   <li class="music-grid-item ..."
//       data-item-id="album-467107251"
//       data-band-id="821915681" ...>
//     <a href="/album/space-is-the-key">
//       <div class="art"><img .../></div>
//       <p class="title">Space Is The Key</p>
//     </a>
//   </li>
// ------------------------------------------------------------
const LI_REGEX =
  /<li[^>]+data-item-id="(album|track)-(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
const HREF_REGEX = /href="(\/(?:album|track)\/[^"]+)"/;
const TITLE_REGEX = /<p[^>]*class="title"[^>]*>([^<]+)<\/p>/;
const BAND_ID_REGEX = /data-band-id="(\d+)"/;

function parseMusicGrid(html, baseUrl) {
  const items = [];
  let match;
  let sortOrder = 0;

  const base = baseUrl.replace(/\/+$/, "");

  LI_REGEX.lastIndex = 0;
  while ((match = LI_REGEX.exec(html)) !== null) {
    const [, itemType, bandcampId, liContent] = match;

    const hrefMatch = liContent.match(HREF_REGEX);
    const titleMatch = liContent.match(TITLE_REGEX);

    const relativeHref = hrefMatch?.[1] ?? null;
    const title = titleMatch ? titleMatch[1].trim() : null;
    const url = relativeHref ? `${base}${relativeHref}` : null;

    items.push({
      bandcamp_id: bandcampId,
      item_type: itemType,
      title,
      url,
      sort_order: sortOrder++,
    });
  }

  return items;
}

// ------------------------------------------------------------
// Bio-container sidebar (present on every Bandcamp page shape — the
// artist page, a track/album/merch page it redirected to, all share
// the same partial). Selectors are attribute-order-tolerant where
// practical; the photo lookup uses a bounded window after
// #pic-container rather than trying to balance nested <div>s with
// regex.
// ------------------------------------------------------------
const BIO_TEXT_REGEX = /<p id="bio-text"[^>]*>([\s\S]*?)<\/p>/;
const LOCATION_REGEX = /<span class="location[^"]*"[^>]*>([^<]*)<\/span>/;
const BAND_NAME_REGEX = /<span class="title"[^>]*>([^<]*)<\/span>/;
const BAND_LINKS_BLOCK_REGEX = /<ol id="band-links"[^>]*>([\s\S]*?)<\/ol>/;
const BAND_LINKS_HREF_REGEX = /href="([^"]+)"/g;
const PIC_CONTAINER_INDEX_REGEX = /id="pic-container"/;
const PIC_HREF_REGEX = /href="([^"]+\.(?:jpe?g|png|gif))"/i;
const PIC_WINDOW_LENGTH = 600;
const TAG_REGEX = /<a[^>]+class="tag"[^>]*>([^<]+)<\/a>/g;
const OG_TYPE_REGEX =
  /<meta[^>]+(?:property|name)=["']og:type["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:type["'][^>]*>/i;
const OG_IMAGE_REGEX =
  /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i;
const ABOUT_REGEX = /<div class="tralbum-about"[^>]*>([\s\S]*?)<\/div>/;
const CREDITS_REGEX = /<div class="tralbum-credits"[^>]*>([\s\S]*?)<\/div>/;

// ------------------------------------------------------------
// Minimal HTML-entity decode — kept as a small local helper rather
// than a shared import (same per-script-copy convention
// sync-soundcloud.mjs's DOMAIN_PLATFORM_MAP comment documents for
// small helpers like this one).
// ------------------------------------------------------------
function decodeHtmlEntities(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function extractBioSidebar(html) {
  const bioTextMatch = html.match(BIO_TEXT_REGEX);
  const bio = bioTextMatch ? decodeHtmlEntities(bioTextMatch[1]) || null : null;

  const locationMatch = html.match(LOCATION_REGEX);
  const location = locationMatch ? decodeHtmlEntities(locationMatch[1]) || null : null;

  const nameMatch = html.match(BAND_NAME_REGEX);
  const bandName = nameMatch ? decodeHtmlEntities(nameMatch[1]) || null : null;

  const links = [];
  const linksBlockMatch = html.match(BAND_LINKS_BLOCK_REGEX);
  if (linksBlockMatch) {
    let hrefMatch;
    BAND_LINKS_HREF_REGEX.lastIndex = 0;
    while ((hrefMatch = BAND_LINKS_HREF_REGEX.exec(linksBlockMatch[1])) !== null) {
      links.push(hrefMatch[1]);
    }
  }

  let photoUrl = null;
  const picIdx = html.search(PIC_CONTAINER_INDEX_REGEX);
  if (picIdx !== -1) {
    const window = html.slice(picIdx, picIdx + PIC_WINDOW_LENGTH);
    const picMatch = window.match(PIC_HREF_REGEX);
    if (picMatch) photoUrl = picMatch[1];
  }

  const tags = [];
  let tagMatch;
  TAG_REGEX.lastIndex = 0;
  while ((tagMatch = TAG_REGEX.exec(html)) !== null) {
    const tag = decodeHtmlEntities(tagMatch[1]).toLowerCase().trim();
    if (tag) tags.push(tag);
  }

  const ogTypeMatch = html.match(OG_TYPE_REGEX);
  const ogType = ogTypeMatch ? (ogTypeMatch[1] || ogTypeMatch[2] || null) : null;

  const ogImageMatch = html.match(OG_IMAGE_REGEX);
  const ogImage = ogImageMatch ? (ogImageMatch[1] || ogImageMatch[2] || null) : null;

  const aboutMatch = html.match(ABOUT_REGEX);
  const about = aboutMatch ? decodeHtmlEntities(aboutMatch[1]) || null : null;

  const creditsMatch = html.match(CREDITS_REGEX);
  const credits = creditsMatch ? decodeHtmlEntities(creditsMatch[1]) || null : null;

  const bandIdMatch = html.match(BAND_ID_REGEX);
  const bandId = bandIdMatch ? bandIdMatch[1] : null;

  // Prefer the sidebar's own band photo (present regardless of which
  // page shape we landed on) over og:image, which on a redirected
  // track/merch page is that release/product's artwork, not the
  // artist. og:image is only usable as a fallback once we know we're
  // actually on the band's own page (og:type=band) — see module
  // header, "Image handling".
  const imageUrl = photoUrl ?? (ogType === "band" ? ogImage : null);

  return { bio, location, bandName, links, tags, imageUrl, about, credits, bandId };
}

// ------------------------------------------------------------
// Platform classification for harvested sidebar links. Per-script
// copy, same convention as sync-soundcloud.mjs / harvest-links-
// discogs.mjs — Bandcamp itself (self-links) is excluded instead of
// SoundCloud.
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
  [/(^|\.)soundcloud\.com$/i, "soundcloud"],
  [/(^|\.)facebook\.com$/i, "facebook"],
  [/(^|\.)fb\.me$/i, "facebook"],
  [/(^|\.)tiktok\.com$/i, "tiktok"],
  [/(^|\.)linktr\.ee$/i, "linktree"],
  [/(^|\.)beatport\.com$/i, "beatport"],
  [/(^|\.)discogs\.com$/i, "discogs"],
];

const TWITTER_HOST_REGEX = /(^|\.)(twitter\.com|x\.com)$/i;
const BANDCAMP_HOST_REGEX = /(^|\.)bandcamp\.com$/i;

function classify(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (TWITTER_HOST_REGEX.test(host)) return null; // excluded per project policy
  if (BANDCAMP_HOST_REGEX.test(host)) return null; // self-link, not useful

  for (const [hostRegex, platform] of DOMAIN_PLATFORM_MAP) {
    if (hostRegex.test(host)) return platform;
  }

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
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

// ------------------------------------------------------------
// Fetch a Bandcamp artist page. Tries /music first (shows the full
// discography grid + bio sidebar when the artist has releases), falls
// back to the root if /music has no useful grid content — same
// fallback enrich-bandcamp.mjs used. Whichever page we land on
// (possibly after a redirect to a track/album/merch page — shapes #2,
// #3, #4 in the module header) still carries the bio-container
// sidebar, so no shape-specific fetch logic is needed beyond this.
// ------------------------------------------------------------
async function fetchBandcampPage(artistUrl) {
  const base = artistUrl.replace(/\/+$/, "");

  let lastStatus = null;

  for (const url of [`${base}/music`, base]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +profile enrichment)",
          Accept: "text/html",
        },
        redirect: "follow",
      });

      lastStatus = res.status;
      if (!res.ok) continue;

      const html = await res.text();
      const finalUrl = res.url || url;

      // Accept ANY successful response unconditionally — unlike the
      // old discography-only enrich-bandcamp.mjs, an empty grid here
      // doesn't mean "try the fallback URL for something better": a
      // genuinely bio-only, no-releases artist (shape #2 in the
      // module header) can have neither a music grid NOR a rendered
      // bio-container (Bandcamp appears to omit that markup entirely
      // when there's truly nothing to show), and that's a legitimate
      // "nothing to harvest" outcome, not a reason to keep probing —
      // treating it as one would misclassify an empty-but-real page
      // as a fetch failure and retry it forever. landedOffBandcamp()
      // (called by the caller) is what actually catches a dead/moved
      // account, by checking where this response's URL ended up, not
      // by judging its content.
      return { html, resolvedBase: base, finalUrl, status: res.status };
    } catch {
      // timeout or network error — try the fallback URL
    } finally {
      clearTimeout(timeout);
    }
  }

  return { html: null, resolvedBase: base, finalUrl: null, status: lastStatus };
}

// ------------------------------------------------------------
// A fetch that landed off Bandcamp entirely, or on the bare
// bandcamp.com apex (homepage/search/login), means the account is
// dead or moved somewhere we can't attribute back to this artist —
// treated the same as a definitive 404. A redirect to a DIFFERENT
// *.bandcamp.com subdomain is still real Bandcamp content and is
// accepted (e.g. a renamed account Bandcamp forwards automatically).
// ------------------------------------------------------------
function landedOffBandcamp(finalUrl) {
  try {
    const host = new URL(finalUrl).hostname.toLowerCase();
    return host === "bandcamp.com" || !host.endsWith(".bandcamp.com");
  } catch {
    return true;
  }
}

// ------------------------------------------------------------
// Supabase pagination — PostgREST caps unpaginated queries at 1000
// rows; fetch in pages until a short page signals the end.
// ------------------------------------------------------------
const SUPABASE_PAGE_SIZE = 1000;

// Directory-only by default — no --approved toggle, matching
// enrich-bandcamp.mjs's original behavior. See module header.
async function fetchAllBandcampLinks() {
  const allRows = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("artist_links")
      .select("id, artist_id, url, artists!inner(name, directory_status, deleted)")
      .eq("platform", "bandcamp")
      .eq("artists.directory_status", "approved")
      .eq("artists.deleted", false)
      .order("id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);

    if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);

    const { data, error } = await query;
    if (error) throw error;

    allRows.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }

  return allRows;
}

// ------------------------------------------------------------
// syncArtist — the single per-artist unit. Fetches one artist's
// Bandcamp page and fans the result out to artist_bandcamp_albums,
// artist_enrichment, biographies, artist_harvested_bios,
// artist_harvested_links, artist_harvested_genres, and (best-effort)
// artist_locations.
// Returns a status object the CLI loop uses for its summary tallies.
//
// opts.artistIdsWithLocation — a mutable Set<artist_id> the caller
// preloads once (see loadArtistIdsWithLocation) and passes in.
// ------------------------------------------------------------
export async function syncArtist(artist, opts = {}) {
  const { debug = false, dryRun = false, artistIdsWithLocation = new Set() } = opts;
  const { artistId, name } = artist;
  // Normalize away a leading www. (see stripBandcampWww) so the fetch
  // and any stored source_url use Bandcamp's canonical bare-subdomain host.
  const bcUrl = stripBandcampWww(artist.bcUrl);

  async function fail(status, { detail, markDone = false } = {}) {
    if (dryRun) return;
    if (markDone) await markProcessed(artistId);
    await recordFailure(supabase, { artistId, service: STATE_SERVICE, status, detail, url: bcUrl });
  }

  // -- Wrong-field / invalid URL guard --
  if (!isBandcampArtistUrl(bcUrl)) {
    console.log(`⚠ ${name}: skipped — stored URL is not a *.bandcamp.com artist page (${bcUrl})`);
    await fail("invalid_bandcamp_url", {
      detail: "stored bandcamp link is not an artist subdomain (bare apex, search URL, or non-bandcamp domain)",
      markDone: true,
    });
    return { status: "skipped_wrong_field" };
  }

  // -- Fetch --
  const result = await fetchBandcampPage(bcUrl);

  if (!result.html) {
    console.log(`✗ ${name}: could not fetch page (HTTP ${result.status ?? "timeout"}) (${bcUrl})`);
    if (result.status === 404 || result.status === 410) {
      await fail("not_found", { detail: `fetch returned HTTP ${result.status}`, markDone: true });
    } else {
      await fail("fetch_failed", { detail: `fetch failed (HTTP ${result.status ?? "timeout"})` });
    }
    await sleep(300);
    return { status: "failed_fetch", httpStatus: result.status };
  }

  const { html, resolvedBase, finalUrl } = result;

  if (landedOffBandcamp(finalUrl)) {
    console.log(`✗ ${name}: redirected off Bandcamp (${finalUrl}) — treating as dead link`);
    await fail("not_found", { detail: `redirected off Bandcamp to ${finalUrl}`, markDone: true });
    await sleep(300);
    return { status: "failed_fetch", httpStatus: null };
  }

  // -- Parse --
  const albums = parseMusicGrid(html, resolvedBase);
  const sidebar = extractBioSidebar(html);

  if (debug) {
    console.log(
      `  [debug] ${name}: albums=${albums.length} bio=${Boolean(sidebar.bio)} ` +
        `location=${sidebar.location ?? "(none)"} links=${sidebar.links.length} ` +
        `tags=${sidebar.tags.length} image=${sidebar.imageUrl ?? "(none)"} finalUrl=${finalUrl}`
    );
  }

  // -- Classify sidebar links --
  const candidates = [];
  const seen = new Set();
  for (const rawUrl of sidebar.links) {
    const platform = classify(rawUrl);
    if (!platform) continue;
    const parsedUrl = normalizeUrl(rawUrl, platform);
    const dedupeKey = `${platform}|${parsedUrl}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({ rawUrl, platform, parsedUrl });
  }

  // -- Writes --
  let writeFailed = false;
  let writeFailDetail = null;

  function noteWriteFailure(label, message) {
    console.error(`  failed to save ${label}: ${message}`);
    writeFailed = true;
    writeFailDetail = writeFailDetail ? `${writeFailDetail}; ${label} failed: ${message}` : `${label} failed: ${message}`;
  }

  if (!dryRun) {
    if (albums.length > 0) {
      const { error: albumsError } = await supabase
        .from("artist_bandcamp_albums")
        .upsert(
          albums.map((item) => ({ artist_id: artistId, ...item })),
          { onConflict: "artist_id,bandcamp_id" }
        );
      if (albumsError) noteWriteFailure("artist_bandcamp_albums", albumsError.message);
    }

    const { error: enrichError } = await supabase.from("artist_enrichment").upsert(
      {
        artist_id: artistId,
        platform: "bandcamp",
        external_id: sidebar.bandId,
        // Images live in artist_images now, not here — see
        // supabase_migration_artist_images.sql and the write below.
        // Explicitly nulled (not omitted) so a stale value from before
        // this change doesn't sit around looking authoritative.
        profile_image_url: null,
        bio: sidebar.bio ? `Bandcamp bio: ${sidebar.bio}` : null,
        follower_count: null, // not available via static scrape — see module header
        track_count: albums.length || null,
        recent_tracks: null,
        playlists: null,
        last_synced_at: new Date().toISOString(),
        sync_error: null,
      },
      { onConflict: "artist_id,platform" }
    );

    if (enrichError) {
      console.log(`✗ ${name}: artist_enrichment upsert failed — ${enrichError.message}`);
      await fail("write_failed", { detail: `artist_enrichment upsert failed: ${enrichError.message}` });
      await sleep(300);
      return { status: "failed_write" };
    }

    // Raw scraped page fields → api_response_cache (namespace 'bandcamp_page',
    // cache_key = artist_id), not artist_enrichment.raw_data (dropped — see
    // supabase_migration_move_raw_data_to_cache.sql). Best-effort archival:
    // re-fetchable, so a failure here is logged but doesn't fail the sync.
    const { error: cacheError } = await supabase.from("api_response_cache").upsert(
      {
        namespace: "bandcamp_page",
        cache_key: String(artistId),
        payload: {
          location: sidebar.location,
          band_name: sidebar.bandName,
          links: sidebar.links,
          tags: sidebar.tags,
          about: sidebar.about,
          credits: sidebar.credits,
          final_url: finalUrl,
        },
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "namespace,cache_key" }
    );
    if (cacheError) {
      console.error(`  ${name}: raw_data cache write failed (non-fatal): ${cacheError.message}`);
    }

    // Image → artist_images (artist_id, platform), not
    // artist_enrichment (see above). Directory-only is already
    // guaranteed here: this whole script only ever processes
    // directory_status = 'approved' artists (see fetchAllBandcampLinks),
    // with no flag to bypass that.
    if (sidebar.imageUrl) {
      const { error: imageError } = await supabase.from("artist_images").upsert(
        {
          artist_id: artistId,
          platform: "bandcamp",
          source_url: sidebar.imageUrl,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "artist_id,platform" }
      );
      if (imageError) noteWriteFailure("artist_images", imageError.message);
    }

    if (sidebar.bio) {
      const { error: bioError } = await supabase.from("artist_harvested_bios").upsert(
        {
          artist_id: artistId,
          source_platform: "bandcamp",
          source_url: bcUrl,
          raw_bio: sidebar.bio,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "artist_id,source_platform" }
      );
      if (bioError) noteWriteFailure("artist_harvested_bios", bioError.message);

      // Display-ready bio → biographies (platform='bandcamp'), the
      // one-bio-per-artist-per-platform home. Same pattern as sync-discogs: raw
      // text stays in artist_harvested_bios (above) as an audit trail, the
      // display bio lands here. Bandcamp's scraped bio is already plain text, so
      // it's the same string in both — no "Bandcamp bio:" prefix, since platform
      // is its own column here (unlike the shared artist_enrichment.bio field).
      const { error: biographyError } = await supabase.from("biographies").upsert(
        {
          artist_id: artistId,
          platform: "bandcamp",
          bio: sidebar.bio,
          source_url: bcUrl,
        },
        { onConflict: "artist_id,platform" }
      );
      if (biographyError) noteWriteFailure("biographies", biographyError.message);
    }

    if (candidates.length > 0) {
      const { error: linksError } = await supabase
        .from("artist_harvested_links")
        .upsert(
          candidates.map((c) => ({
            artist_id: artistId,
            source_platform: "bandcamp",
            source_url: bcUrl,
            raw_url: c.rawUrl,
            parsed_platform: c.platform,
            parsed_url: c.parsedUrl,
          })),
          { onConflict: "artist_id,parsed_url", ignoreDuplicates: true }
        );
      if (linksError) noteWriteFailure("artist_harvested_links", linksError.message);
    }

    if (sidebar.tags.length > 0) {
      const { error: genresError } = await supabase
        .from("artist_harvested_genres")
        .upsert(
          sidebar.tags.map((tag) => ({
            artist_id: artistId,
            source_platform: "bandcamp",
            raw_tag: tag,
          })),
          { onConflict: "artist_id,source_platform,raw_tag", ignoreDuplicates: true }
        );
      if (genresError) noteWriteFailure("artist_harvested_genres", genresError.message);
    }

    // Location — best-effort raw_text only (structured city/country
    // parsing is a future enhancement, same status as Discogs
    // namevariations/aliases in PIPELINE.md); never clobbers an
    // existing row.
    if (sidebar.location && !artistIdsWithLocation.has(artistId)) {
      const { error: locationError } = await supabase
        .from("artist_locations")
        .insert({ artist_id: artistId, raw_text: sidebar.location });
      if (locationError) {
        noteWriteFailure("artist_locations", locationError.message);
      } else {
        artistIdsWithLocation.add(artistId);
      }
    }

    if (writeFailed) {
      await fail("write_failed", { detail: writeFailDetail });
    } else {
      await markProcessed(artistId);
      await clearFailure(supabase, { artistId, service: STATE_SERVICE });
    }
  }

  const albumsNote = albums.length > 0 ? `${albums.length} release(s)` : "no releases";
  const bioPreview = sidebar.bio
    ? `"${sidebar.bio.slice(0, 60)}${sidebar.bio.length > 60 ? "…" : ""}"`
    : "(no bio)";
  const linksNote =
    candidates.length > 0 ? `, ${candidates.length} link(s) — ${candidates.map((c) => c.platform).join(", ")}` : "";
  console.log(`✓ ${name}: ${albumsNote}${linksNote}, ${bioPreview}`);

  await sleep(300);

  return {
    status: writeFailed ? "failed_write" : "synced",
    albumsFound: albums.length,
    linksFound: candidates.length,
    linksByPlatform: candidates.reduce((acc, c) => {
      acc[c.platform] = (acc[c.platform] ?? 0) + 1;
      return acc;
    }, {}),
    tagsFound: sidebar.tags.length,
    hasBio: Boolean(sidebar.bio),
    hasLocation: Boolean(sidebar.location),
  };
}

// ------------------------------------------------------------
// Failures CSV — same convention as sync-soundcloud.mjs.
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
  const outPath = path.join(outDir, `sync-bandcamp-failures-${timestamp()}.csv`);
  fs.writeFileSync(outPath, csv);
  console.log(`\nWrote ${rows.length} current failure(s) to ${outPath}`);
}

// ------------------------------------------------------------
// Main (CLI entry) — a thin loop over syncArtist().
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running Bandcamp sync\n");
  console.log("Directory-only: processing artists with directory_status = 'approved'\n");

  const processed = FORCE ? new Set() : await loadProcessedArtistIds();
  if (FORCE) {
    console.log("--force: bypassing resolved_artists state\n");
  } else if (processed.size > 0) {
    console.log(
      `State loaded: ${processed.size} artist(s) already processed (resolved_artists; pass --force to bypass)\n`
    );
  }

  const artistIdsWithLocation = await loadArtistIdsWithLocation();

  const links = await fetchAllBandcampLinks();

  let rows = links;
  let skippedProcessed = 0;
  let retriedLinkChanged = 0;
  if (!FORCE) {
    const failedUrls = await loadFailureUrls(supabase, { service: STATE_SERVICE });

    const remaining = [];
    for (const row of links) {
      if (processed.has(row.artist_id)) {
        const failedUrl = failedUrls.get(row.artist_id);
        if (failedUrl && failedUrl !== row.url) {
          remaining.push(row);
          retriedLinkChanged++;
        } else {
          skippedProcessed++;
        }
      } else {
        remaining.push(row);
      }
    }
    rows = remaining;
  }
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(
    `Found ${links.length} Bandcamp link(s)` +
      (skippedProcessed > 0 ? `, ${skippedProcessed} already processed (skipped)` : "") +
      (retriedLinkChanged > 0 ? `, ${retriedLinkChanged} retried (link changed since a prior failure)` : "") +
      `${LIMIT ? `, processing next ${rows.length}` : ""}\n`
  );

  let attempted = 0;
  let synced = 0;
  let skippedWrongField = 0;
  let failedFetch = 0;
  let failedWrite = 0;
  let totalAlbums = 0;
  let totalLinksFound = 0;
  let biosFound = 0;
  let locationsFound = 0;
  const byPlatform = {};

  for (const row of rows) {
    const name = row.artists?.name ?? row.artist_id;
    attempted++;

    const result = await syncArtist(
      { artistId: row.artist_id, name, bcUrl: row.url },
      { debug: DEBUG, dryRun: DRY_RUN, artistIdsWithLocation }
    );

    switch (result.status) {
      case "synced":
        synced++;
        totalAlbums += result.albumsFound ?? 0;
        totalLinksFound += result.linksFound ?? 0;
        if (result.hasBio) biosFound++;
        if (result.hasLocation) locationsFound++;
        for (const [platform, count] of Object.entries(result.linksByPlatform ?? {})) {
          byPlatform[platform] = (byPlatform[platform] ?? 0) + count;
        }
        break;
      case "skipped_wrong_field":
        skippedWrongField++;
        break;
      case "failed_fetch":
        failedFetch++;
        break;
      case "failed_write":
        failedWrite++;
        break;
    }
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  attempted:              ${attempted}`);
  console.log(`  skipped (processed):    ${skippedProcessed}`);
  if (retriedLinkChanged > 0) {
    console.log(`  retried (link changed): ${retriedLinkChanged}`);
  }
  console.log(`  skipped (wrong field):  ${skippedWrongField}`);
  console.log(`  fetch failed:           ${failedFetch}`);
  console.log(`  write failed:           ${failedWrite}`);
  console.log(`  ${DRY_RUN ? "would sync" : "synced"}:                ${synced}`);
  console.log(`  total albums/tracks:    ${totalAlbums}`);
  console.log(`  bios found:             ${biosFound}`);
  console.log(`  locations found:        ${locationsFound}`);
  console.log(`  total links found:      ${totalLinksFound}`);
  for (const [platform, count] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${platform}: ${count}`);
  }

  await writeFailuresCsv();
}

main().catch((err) => {
  console.error("\nSync failed:", err?.message ?? err);
  process.exit(1);
});
