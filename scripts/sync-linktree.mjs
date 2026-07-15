#!/usr/bin/env node
// ============================================================
// sync-linktree.mjs — Phase 2c Linktree sync.
//
// The Linktree analog of sync-soundcloud.mjs / sync-bandcamp.mjs /
// sync-hoer.mjs. For each artist with a Linktree link in artist_links
// (platform='linktree'), it fetches the artist's linktr.ee page ONCE
// and fans the single response out to every concern that page can
// answer:
//
//   - External links   → staged into artist_harvested_links
//                        (source_platform='linktree'); never written to
//                        artist_links directly. integrate-harvested-
//                        links.mjs (2d) / harvest-links-loop.mjs promote.
//                        THIS is why sync-linktree is a real convergence-
//                        loop member: a Linktree lists an artist's other
//                        platforms (Spotify/SoundCloud/Bandcamp/…), which
//                        the other harvesters then feed on.
//   - Bio / tagline    → biographies (platform='linktree') + the raw text
//                        into artist_harvested_bios (source_platform=
//                        'linktree') as an audit trail. Linktree bios
//                        often carry genre hints ("HARD TECHNO/HARD MUSIC
//                        DJ AND PRODUCER"); genres are NOT parsed here —
//                        that's a deliberate future cross-platform pass
//                        over artist_harvested_bios (see PIPELINE.md).
//   - Profile picture  → artist_images (platform='linktree'), source_url
//                        only (store-images.mjs, 5b, re-hosts). APPROVED-
//                        ONLY, checked inside syncArtist regardless of
//                        which flags scoped the run — like SoundCloud,
//                        this script can process non-directory artists too
//                        (Linktree links get attached to non-directory
//                        sc_followee nodes by sync-soundcloud's bio
//                        extraction), and there's no reason to store
//                        images for artists that aren't shown anywhere.
//                        NOTE: Linktree images are deliberately HELD BACK
//                        from the public day-seeded display rotation for
//                        now (a Linktree avatar is sometimes a logo/event
//                        flyer, not an artist photo) — see the
//                        platform='linktree' exclusion in
//                        src/lib/artist-images.ts. They're still captured
//                        and re-hosted so the decision can be revisited.
//
// Link classification — the Linktree-specific twist. The other
// harvesters pull from CURATED "my links" lists, so lumping any
// unrecognized domain into "other" is fine. A Linktree, by contrast,
// commonly holds dozens of ONE-OFF links (event tickets, merch, a single
// release, a newsletter). Classifying those as "other" would flood the
// staging table and, worse, 2d would promote one arbitrary junk "other"
// link as the artist's live "other" link (because "other" IS a key in
// the platforms table). So here:
//   - a link whose domain we recognize gets its canonical platform key;
//   - EVERY unrecognized domain is stored under its BARE DOMAIN (e.g.
//     "dice.fm") as parsed_platform — never "other".
// 2d only promotes rows whose parsed_platform is a key in the platforms
// table, so bare-domain rows stay staged, human-readable, and
// un-promoted. Retain-everything, promote-known-only: the day a domain
// is added to the known list (a platforms row), a 2d re-run promotes the
// already-gathered backlog for it. See PIPELINE.md, "sync-linktree".
//
// Wrong-field URL guard: before spending a fetch, the stored link's host
// is checked against linktr.ee. A non-Linktree URL saved in the linktree
// field is skipped, flagged in harvest_failures, and — like a 404 —
// marked processed (it won't fix itself on retry); a later link
// correction is picked up automatically by the link-changed cross-check.
//
// State/failures live in the DATABASE (project rule — no cache files):
//   - resolved_artists / harvest_failures, service = 'linktree-sync',
//     via scripts/lib/harvest-failures.mjs (same as every other
//     harvester). An artist marked processed on a 404 or wrong-field
//     failure is retried automatically once its stored link changes
//     (loadFailureUrls cross-check) — no --force needed.
//   - Every run also writes a timestamped snapshot of the current
//     'linktree-sync' harvest_failures rows to
//     sync-linktree-failures-<ts>.csv one level up from the repo (the
//     "Rebalance Gender" folder), same as the other sync scripts, so an
//     unattended run's failures are queryable afterward.
//
// Parsing: linktr.ee is a client-rendered Next.js app, but it
// server-renders the profile data into the __NEXT_DATA__ JSON blob (real
// destination URLs, not linktr.ee redirects). We parse that blob for
// links/bio/avatar, with HTML fallbacks (og:description for the bio, the
// first ugc.production.linktr.ee image for the avatar, body anchors for
// links) so a markup change degrades rather than breaks. No headless
// browser (project rule: avoid heavy installs).
//
// The per-artist unit is the exported syncArtist(); main() is a thin CLI
// driver over it — the same shape a future on-approval single-artist call
// could use.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/sync-linktree.mjs                 # all unprocessed artists with a linktree link
//   node scripts/sync-linktree.mjs --approved      # only directory artists (directory_status='approved')
//   node scripts/sync-linktree.mjs --limit=20      # only the first 20 (for testing)
//   node scripts/sync-linktree.mjs --name="Danz"   # artists whose name contains this
//   node scripts/sync-linktree.mjs --force         # re-process even artists with a state row
//   node scripts/sync-linktree.mjs --debug         # log every link classified
//   DRY_RUN=1 node scripts/sync-linktree.mjs       # fetch + log, no DB writes
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// (No token — linktr.ee pages are public.)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordFailure, clearFailure, loadFailureUrls } from "./lib/harvest-failures.mjs";
import { canonicalizeResidentAdvisorUrl } from "./lib/ra-url.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const STATE_SERVICE = "linktree-sync"; // resolved_artists.service / harvest_failures.service

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const FORCE = args.includes("--force");
// --approved: only process artists in the live directory
// (directory_status='approved'). Forwarded by harvest-links-loop.mjs /
// the orchestrator to restrict every stage with one flag.
const APPROVED_ONLY = args.includes("--approved");
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
// Used only to build the artist-page URL in the failures CSV — same env
// var and fallback the site itself uses (src/lib/email.ts).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rebalance-gender.app";

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });

// ------------------------------------------------------------
// Linktree HTTP — throttled, timeout, one retry on 429/5xx. No official
// API and no published rate limit, so be conservative: ~1 req/sec.
// ------------------------------------------------------------
const THROTTLE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

const UA = "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +profile enrichment)";

async function linktreeFetch(url, { retried = false } = {}) {
  await throttle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
    });
    if ((res.status === 429 || res.status >= 500) && !retried) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "5", 10);
      await sleep(Math.min(retryAfter, 30) * 1000);
      return linktreeFetch(url, { retried: true });
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------
// Wrong-field URL guard. A valid Linktree link lives on linktr.ee (or a
// linktr.ee subdomain). linktree.com is also accepted (the marketing
// domain occasionally saved as a profile URL). Anything else is a
// wrong-field entry.
// ------------------------------------------------------------
export function isLinktreeUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === "linktr.ee" ||
      host.endsWith(".linktr.ee") ||
      host === "linktree.com" ||
      host.endsWith(".linktree.com")
    );
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Link classification. Same per-script-copy DOMAIN_PLATFORM_MAP
// convention as sync-discogs.mjs / sync-hoer.mjs — but with the
// Linktree-specific fallback: unrecognized domains are classified by
// their BARE DOMAIN (not "other"), so 2d retains-but-doesn't-promote
// them. See the module header. linktr.ee self-links and Twitter/X
// (project policy) are skipped.
// ------------------------------------------------------------
const DOMAIN_PLATFORM_MAP = [
  [/(^|\.)soundcloud\.com$/i, "soundcloud"],
  [/(^|\.)instagram\.com$/i, "instagram"],
  [/(^|\.)open\.spotify\.com$/i, "spotify"],
  [/(^|\.)spotify\.com$/i, "spotify"],
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
  [/(^|\.)beatport\.com$/i, "beatport"],
  [/(^|\.)discogs\.com$/i, "discogs"],
  [/(^|\.)qobuz\.com$/i, "qobuz"],
  [/(^|\.)tidal\.com$/i, "tidal"],
  [/(^|\.)songkick\.com$/i, "songkick"],
  [/(^|\.)music\.apple\.com$/i, "apple_music"],
  [/(^|\.)itunes\.apple\.com$/i, "apple_music"],
  [/(^|\.)last\.fm$/i, "lastfm"],
  [/(^|\.)lastfm\.[a-z]+$/i, "lastfm"],
  [/(^|\.)musicbrainz\.org$/i, "musicbrainz"],
  // mixcloud is a real music platform but not (yet) a tracked platform
  // key — classify it explicitly so it stays staged under 'mixcloud'
  // (retained, not promoted) rather than the promotable "other".
  [/(^|\.)mixcloud\.com$/i, "mixcloud"],
];

const SKIP_HOST_REGEXES = [
  /(^|\.)(twitter\.com|x\.com|t\.co)$/i, // excluded per project policy
  /(^|\.)linktr\.ee$/i, // self-links (Linktree's own footer/marketing)
  /(^|\.)linktree\.com$/i,
];

function normalizeUrl(url) {
  const u = new URL(url.toString());
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  // Instagram share/tracking params are noise; strip for a stable key.
  if (/(^|\.)instagram\.com$/i.test(u.hostname)) u.search = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

// Bare registrable-ish domain used as the parsed_platform for
// unrecognized links: the hostname minus a leading "www." (no public-
// suffix logic — this is a human-readable retention label, not a
// canonical key). e.g. "www.dice.fm" -> "dice.fm".
function bareDomain(host) {
  return host.toLowerCase().replace(/^www\./, "");
}

export function classifyLinktreeUrl(rawUrl) {
  // Rewrite pre-rebrand residentadvisor.net links onto ra.co up front, so
  // both the platform match and the stored parsed_url use the current host.
  rawUrl = canonicalizeResidentAdvisorUrl(rawUrl);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // unparseable — skip
  }
  if (!/^https?:$/.test(url.protocol)) return null; // mailto:, tel:, etc.
  const host = url.hostname.toLowerCase();
  for (const re of SKIP_HOST_REGEXES) if (re.test(host)) return null;
  if (host.endsWith(".wikipedia.org") || host === "wikipedia.org") {
    return { platform: "wikipedia", parsedUrl: normalizeUrl(url) };
  }
  for (const [re, platform] of DOMAIN_PLATFORM_MAP) {
    if (re.test(host)) return { platform, parsedUrl: normalizeUrl(url) };
  }
  // Unrecognized: retain under the bare domain, never "other".
  return { platform: bareDomain(host), parsedUrl: normalizeUrl(url) };
}

// ------------------------------------------------------------
// Linktree page parsing.
// ------------------------------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&#8217;|&rsquo;/gi, "’")
    .replace(/&#8216;|&lsquo;/gi, "‘")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

// Pull the __NEXT_DATA__ JSON blob (Linktree is a Next.js app that
// server-renders profile data into it).
function extractNextData(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Locate the Linktree "account" object inside the parsed __NEXT_DATA__.
// Prefer the known path; fall back to a bounded breadth-first search for
// an object that looks like an account (has a `links` array plus a
// profile-ish field), so a shift in the Next.js props shape degrades
// gracefully instead of breaking.
function findAccount(nextData) {
  const direct = nextData?.props?.pageProps?.account;
  if (direct && Array.isArray(direct.links)) return direct;
  const queue = [nextData];
  let steps = 0;
  while (queue.length && steps < 20000) {
    const node = queue.shift();
    steps++;
    if (!node || typeof node !== "object") continue;
    if (
      !Array.isArray(node) &&
      Array.isArray(node.links) &&
      ("username" in node ||
        "pageTitle" in node ||
        "profilePictureUrl" in node ||
        "description" in node)
    ) {
      return node;
    }
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      if (v && typeof v === "object") queue.push(v);
    }
  }
  return null;
}

// Parse a linktr.ee page into { bio, imageUrl, links[] }. Any field may
// legitimately be absent. Prefers the __NEXT_DATA__ JSON; falls back to
// the server-rendered HTML for each field independently.
export function parseLinktreePage(html) {
  const nextData = extractNextData(html);
  const account = nextData ? findAccount(nextData) : null;

  const links = [];
  let bio = null;
  let imageUrl = null;

  if (account) {
    for (const l of Array.isArray(account.links) ? account.links : []) {
      if (typeof l?.url === "string" && l.url.trim()) links.push(l.url.trim());
    }
    for (const s of Array.isArray(account.socialLinks) ? account.socialLinks : []) {
      if (typeof s?.url === "string" && s.url.trim()) links.push(s.url.trim());
    }
    if (typeof account.description === "string" && account.description.trim()) {
      bio = account.description.trim();
    }
    if (typeof account.profilePictureUrl === "string" && account.profilePictureUrl.trim()) {
      imageUrl = account.profilePictureUrl.trim();
    }
  }

  // -- HTML fallbacks --
  if (!bio) {
    const og =
      firstMatch(html, /<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
      firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']og:description["']/i) ||
      firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    if (og && decodeEntities(og).trim()) bio = decodeEntities(og).trim();
  }
  if (!imageUrl) {
    const m = html.match(/https:\/\/ugc\.production\.linktr\.ee\/[^\s"'<>()]+/i);
    if (m) imageUrl = decodeEntities(m[0]);
  }
  if (links.length === 0) {
    // Last resort — external anchors from the rendered body. Linktree's
    // own footer/marketing links are all linktr.ee (skipped in classify),
    // so this mostly recovers the real destination links.
    const re = /href=["'](https?:\/\/[^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) links.push(decodeEntities(m[1]));
  }

  return { bio, imageUrl, links };
}

// ------------------------------------------------------------
// Supabase pagination (PostgREST caps unpaginated queries at 1000 rows).
// ------------------------------------------------------------
const PAGE_SIZE = 1000;

async function fetchAllLinktreeLinks() {
  const allRows = [];
  let from = 0;
  while (true) {
    let query = supabase
      .from("artist_links")
      .select("id, artist_id, url, artists!inner(name, directory_status, deleted)")
      .eq("platform", "linktree")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (APPROVED_ONLY) {
      query = query.eq("artists.directory_status", "approved").eq("artists.deleted", false);
    }
    if (NAME_FILTER) query = query.ilike("artists.name", `%${NAME_FILTER}%`);
    const { data, error } = await query;
    if (error) throw error;
    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

async function loadProcessedArtistIds() {
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("resolved_artists")
      .select("artist_id")
      .eq("service", STATE_SERVICE)
      .order("artist_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.artist_id);
    if ((data?.length ?? 0) < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return ids;
}

// Artist IDs that already have a stored linktree image — so an artist
// approved AFTER their (non-directory) sync can be re-run to pick up
// just the now-eligible image (image writes are approved-only), without
// the separate image-only machinery sync-soundcloud carries.
async function loadArtistIdsWithLinktreeImage() {
  const ids = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("artist_images")
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
// syncArtist — the single per-artist unit. Fetches one Linktree page and
// fans it out to staged links, biographies/artist_harvested_bios, and
// (approved artists only) artist_images. Returns a status object the CLI
// loop tallies.
// ------------------------------------------------------------
export async function syncArtist(artist, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const { artistId, name, linktreeUrl, directoryStatus } = artist;
  const isApproved = directoryStatus === "approved";

  // -- Wrong-field URL guard: skip before spending a fetch --
  if (!isLinktreeUrl(linktreeUrl)) {
    console.log(`⚠ ${name}: skipped — stored URL is not a linktr.ee link (${linktreeUrl})`);
    if (!dryRun) {
      // Marked processed, same reasoning as a 404: a wrong-field link
      // won't fix itself on retry; the loadFailureUrls cross-check
      // un-sticks it automatically once a human corrects the link.
      await recordFailure(supabase, {
        artistId,
        service: STATE_SERVICE,
        status: "wrong_field_url",
        detail: "stored linktree link is not a linktr.ee URL",
        url: linktreeUrl,
      });
      await markProcessed(artistId);
    }
    return { status: "skipped_wrong_field" };
  }

  // -- Fetch the page --
  let res;
  try {
    res = await linktreeFetch(linktreeUrl);
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    const status = res?.status ?? 0;
    console.log(`✗ ${name}: Linktree HTTP ${status}`);
    if (!dryRun) {
      const is404 = status === 404;
      await recordFailure(supabase, {
        artistId,
        service: STATE_SERVICE,
        status: is404 ? "fetch_404" : "fetch_failed",
        detail: `Linktree HTTP ${status}`,
        url: linktreeUrl,
      });
      // 404 = definitive dead page → mark processed so the loop converges
      // (cross-check retries if the link is later corrected). Other
      // statuses (5xx, timeout) are possibly transient → leave unmarked.
      if (is404) await markProcessed(artistId);
    }
    return { status: "failed_fetch", httpStatus: status };
  }

  const html = await res.text();
  const parsed = parseLinktreePage(html);

  // -- Classify + dedupe links --
  const seen = new Set();
  const candidates = [];
  for (const rawUrl of parsed.links) {
    const c = classifyLinktreeUrl(rawUrl);
    if (!c) continue;
    if (seen.has(c.parsedUrl)) continue;
    seen.add(c.parsedUrl);
    candidates.push({
      artist_id: artistId,
      source_platform: "linktree",
      source_url: linktreeUrl,
      raw_url: rawUrl,
      parsed_platform: c.platform,
      parsed_url: c.parsedUrl,
    });
    if (debug) console.log(`    link ${String(c.platform).padEnd(20)} ${c.parsedUrl}`);
  }

  if (dryRun) {
    console.log(
      `~ ${name}: would stage ${candidates.length} link(s)` +
        `${parsed.bio ? ", bio" : ""}${parsed.imageUrl && isApproved ? ", image" : ""}`
    );
    return {
      status: "synced",
      linksFound: candidates.length,
      newByPlatform: tallyByPlatform(candidates),
      hasBio: Boolean(parsed.bio),
      imageStored: false,
    };
  }

  let allWritesOk = true;
  const writeFailed = (label, err) => {
    allWritesOk = false;
    console.error(`  (${name}: ${label} failed: ${err?.message ?? err})`);
  };

  // -- Links → artist_harvested_links (staged) --
  let newLinkCount = 0;
  const newByPlatform = {};
  if (candidates.length) {
    const { data: ins, error } = await supabase
      .from("artist_harvested_links")
      .upsert(candidates, { onConflict: "artist_id,parsed_url", ignoreDuplicates: true })
      .select("id, parsed_platform");
    if (error) {
      writeFailed("staging links", error);
    } else {
      const rows = ins ?? [];
      newLinkCount = rows.length;
      for (const r of rows) newByPlatform[r.parsed_platform] = (newByPlatform[r.parsed_platform] ?? 0) + 1;
    }
  }

  // -- Bio → biographies (cleaned) + artist_harvested_bios (raw audit) --
  // No markup to strip on a Linktree tagline, so both get the same text.
  if (parsed.bio) {
    const { error: bioErr } = await supabase
      .from("biographies")
      .upsert(
        { artist_id: artistId, platform: "linktree", bio: parsed.bio, source_url: linktreeUrl },
        { onConflict: "artist_id,platform" }
      );
    if (bioErr) writeFailed("biography", bioErr);
    const { error: rawErr } = await supabase
      .from("artist_harvested_bios")
      .upsert(
        { artist_id: artistId, source_platform: "linktree", source_url: linktreeUrl, raw_bio: parsed.bio },
        { onConflict: "artist_id,source_platform" }
      );
    if (rawErr) writeFailed("raw bio audit", rawErr);
  }

  // -- Image → artist_images (approved artists only) --
  let imageStored = false;
  if (isApproved && parsed.imageUrl) {
    const { error } = await supabase.from("artist_images").upsert(
      {
        artist_id: artistId,
        platform: "linktree",
        source_url: parsed.imageUrl,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "artist_id,platform" }
    );
    if (error) writeFailed("artist_images", error);
    else imageStored = true;
  }

  if (allWritesOk) {
    await clearFailure(supabase, { artistId, service: STATE_SERVICE });
    await markProcessed(artistId);
    console.log(
      `✓ ${name}: ${newLinkCount} new link(s)` +
        (parsed.bio ? ", bio" : "") +
        (imageStored ? ", image" : "")
    );
    return {
      status: "synced",
      linksFound: candidates.length,
      newLinkCount,
      newByPlatform,
      hasBio: Boolean(parsed.bio),
      imageStored,
    };
  }

  // A write failed — leave unmarked so the (idempotent) writes retry.
  await recordFailure(supabase, {
    artistId,
    service: STATE_SERVICE,
    status: "write_failed",
    detail: "one or more writes failed",
    url: linktreeUrl,
  });
  console.log(`⚠ ${name}: synced with write error(s) — left unprocessed for retry`);
  return { status: "failed_write" };
}

function tallyByPlatform(candidates) {
  const out = {};
  for (const c of candidates) out[c.parsed_platform] = (out[c.parsed_platform] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------
// Failures CSV — a snapshot of every current 'linktree-sync' row in
// harvest_failures, written every run (same convention as
// sync-soundcloud.mjs / other-links-domain-counts.mjs). Saved one level
// up from the repo with a datetime in the name, so a re-run never
// overwrites a previous report.
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

  const outPath = path.join(path.resolve(__dirname, "..", ".."), `sync-linktree-failures-${timestamp()}.csv`);
  fs.writeFileSync(outPath, csv);
  console.log(`\nWrote ${rows.length} current failure(s) to ${outPath}`);
}

// ------------------------------------------------------------
// Main (CLI entry) — a thin loop over syncArtist().
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "sync-linktree — DRY RUN (no writes)\n" : "sync-linktree — syncing from Linktree\n");
  if (APPROVED_ONLY) console.log("--approved: restricting to directory artists (directory_status='approved').\n");

  const links = await fetchAllLinktreeLinks();
  const byArtist = new Map();
  for (const row of links) if (!byArtist.has(row.artist_id)) byArtist.set(row.artist_id, row);

  const processed = FORCE ? new Set() : await loadProcessedArtistIds();
  // Two failure statuses mark an artist processed (wrong_field_url,
  // fetch_404) yet should retry once the stored link changes —
  // resolved_artists only records "done for this artist_id", not which
  // URL was checked. Cross-reference the URL recorded at failure time
  // against the current link.
  const failureUrls = FORCE ? new Map() : await loadFailureUrls(supabase, { service: STATE_SERVICE });
  const withImage = FORCE ? new Set() : await loadArtistIdsWithLinktreeImage();

  let retriedLinkChanged = 0;
  let imageGap = 0;
  let targets = [...byArtist.values()].filter((row) => {
    if (FORCE) return true;
    if (!processed.has(row.artist_id)) return true;
    const failedUrl = failureUrls.get(row.artist_id);
    if (failedUrl != null && failedUrl !== row.url) {
      retriedLinkChanged++;
      return true; // link changed since it failed
    }
    // Approved after a prior (image-ineligible) sync but still missing a
    // linktree image → re-run to pick it up. syncArtist re-writes bio/
    // links idempotently, which is harmless.
    const isApproved = row.artists?.directory_status === "approved";
    if (isApproved && !withImage.has(row.artist_id)) {
      imageGap++;
      return true;
    }
    return false;
  });
  const skippedProcessed = byArtist.size - targets.length;
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(
    `${byArtist.size} ${APPROVED_ONLY ? "approved " : ""}artist(s) have a Linktree link` +
      (skippedProcessed > 0 && !FORCE ? `, ${skippedProcessed} already processed` : "") +
      (retriedLinkChanged > 0 ? `, ${retriedLinkChanged} retried (link changed)` : "") +
      (imageGap > 0 ? `, ${imageGap} re-run for a missing image` : "") +
      `. ${targets.length} to process.\n`
  );

  const stats = {
    synced: 0,
    skippedWrongField: 0,
    failedFetch: 0,
    failedWrite: 0,
    totalNewLinks: 0,
    bios: 0,
    images: 0,
  };
  const stagedByPlatform = {};

  for (const row of targets) {
    const name = row.artists?.name ?? row.artist_id;
    const result = await syncArtist(
      { artistId: row.artist_id, name, linktreeUrl: row.url, directoryStatus: row.artists?.directory_status },
      { dryRun: DRY_RUN, debug: DEBUG }
    );
    switch (result.status) {
      case "synced":
        stats.synced++;
        stats.totalNewLinks += result.newLinkCount ?? result.linksFound ?? 0;
        if (result.hasBio) stats.bios++;
        if (result.imageStored) stats.images++;
        for (const [p, c] of Object.entries(result.newByPlatform ?? {})) {
          stagedByPlatform[p] = (stagedByPlatform[p] ?? 0) + c;
        }
        break;
      case "skipped_wrong_field":
        stats.skippedWrongField++;
        break;
      case "failed_fetch":
        stats.failedFetch++;
        break;
      case "failed_write":
        stats.failedWrite++;
        break;
    }
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  ${DRY_RUN ? "would sync" : "synced"}:            ${stats.synced}`);
  console.log(`  skipped (wrong field):  ${stats.skippedWrongField}`);
  console.log(`  fetch failed:           ${stats.failedFetch}`);
  console.log(`  write failed:           ${stats.failedWrite}`);
  console.log(`  new links staged:       ${stats.totalNewLinks}`);
  for (const [p, c] of Object.entries(stagedByPlatform).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${p}: ${c}`);
  }
  console.log(`  bios:                   ${stats.bios}`);
  console.log(`  images stored:          ${stats.images}`);

  if (stats.totalNewLinks > 0) {
    console.log("\nNext: node scripts/integrate-harvested-links.mjs (2d) to promote staged links.");
  }

  await writeFailuresCsv();
}

// Run main() only as a CLI entry point, so the pure parsing/classifying
// helpers above can be imported (e.g. by a unit test) without kicking off
// a full run.
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("\nsync-linktree failed:", err?.message ?? err);
    process.exit(1);
  });
}
