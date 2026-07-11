#!/usr/bin/env node
// ============================================================
// sync-hoer.mjs — one-source sync for HÖR (https://hoer.live).
//
// The HÖR analog of sync-discogs.mjs / sync-bandcamp.mjs, but with an
// extra job the others don't have: HÖR is a *directory we import from*,
// not just a platform some existing artists link to. So this script
// both SEEDS new artists (status 'pending') from HÖR's roster and
// ENRICHES them from HÖR's own pages/API. It replaces the old plan of
// importing an .ods export — the roster is read live from the site.
//
// HÖR is WordPress. Three things it exposes (all verified):
//
//   • Artists  = the `ppma_author` taxonomy (PublishPress Multiple
//     Authors). /wp-json/wp/v2/ppma_author lists every artist with its
//     slug and /artist/<slug>/ link. NOTE: the term `name` is the
//     artist's LEGAL name, not the stage name — it goes to the PRIVATE
//     artist_legal_names table (see supabase_migration_artist_legal_names.sql),
//     never shown. The stage name comes from the page <h1> (Phase 2).
//
//   • DJ sets  = plain `post`s. Genre tags are `post_tag` (exposed on
//     each post as `tags`), and the crediting artist(s) are `ppma_author`
//     (an array — >1 author = a collaboration). /wp-json/wp/v2/posts
//     with ?after=<date> gives incremental "only new sets since last run".
//
//   • Stage name / portrait / socials = the SERVER-RENDERED /artist/<slug>/
//     page. Parsed from raw HTML: h1.artist__title, div.artist__image
//     (inline background-image), div.artist__socials a. NOTE: the page has
//     TWO .artist__socials blocks — a JS-template placeholder (empty hrefs)
//     first, then the real one; parseArtistPage scans BOTH and keeps the
//     non-empty hrefs.
//
//   • Bio = the WordPress USER record, /wp-json/wp/v2/users/<id>.description.
//     An /artist/<slug>/ page is a WP *author archive*; its .artist__text div
//     is an empty placeholder that JS fills client-side, so the bio is NEVER
//     in the server HTML (the `ppma_author` TERM's description/acf are empty
//     too — a different object; do not confuse the two). Phase 2 reads the
//     user id from the page body class (author-<id>) and fetches the bio from
//     the user API. Guest / orphan terms have no user archive → no bio.
//
// Fan-out (mirrors sync-discogs.mjs — one source, every concern it can
// answer):
//
//   roster (ppma_author)   → artists (directory_status='pending') +
//                            artist_links (platform='hoer', written
//                            DIRECTLY — this is the identity link, not a
//                            discovered one) + artist_legal_names
//                            (platform='hoer') for the LEGAL name — a
//                            PRIVATE table shared with sync-discogs (no
//                            public read; see the migration). Never shown.
//   set genres (post_tag)  → artist_harvested_genres (source_platform=
//                            'hoer'); integrate-harvested-genres promotes
//   multi-artist sets      → collaborations (source_platform='hoer')
//   user bio (users API)   → biographies (platform='hoer') +
//                            artist_harvested_bios (raw audit trail)
//   page portrait          → artist_images (platform='hoer'); store-
//                            images.mjs re-hosts it
//   page socials           → artist_harvested_links (source_platform=
//                            'hoer'); integrate-harvested-links promotes.
//                            THIS is why sync-hoer is a real convergence-
//                            loop member: a HÖR page reveals an Instagram/
//                            SoundCloud link the other harvesters feed on.
//   full per-artist blob   → api_response_cache (namespace 'hoer-artist',
//                            key = slug): the raw WP user record + parsed
//                            page fields + ids. Durable harvest store so
//                            un-extracted fields can be mined later without
//                            re-scraping (same role as 'discogs-artist').
//
// State lives in the DATABASE (project rule — no cache files):
//   • resolved_artists / harvest_failures, service = 'hoer-sync'
//     (per-artist "page already scraped", via scripts/lib/harvest-
//     failures.mjs, same as every other harvester).
//   • hoer_sync_state.last_set_date — the incremental set cursor. Each
//     run ingests only posts newer than this, so a shared set's
//     collaborations.collab_count is never double-counted on re-runs.
//
// Phases (all in one run; cheap on re-runs because of the two state
// mechanisms above, so it terminates naturally inside the loop):
//   0. Enumerate ppma_author → seed new artists + hoer links.
//   1. Crawl posts?after=<cursor> → stage genres, collaboration edges;
//      advance the cursor.
//   2. Scrape /artist/<slug>/ for artists not yet scraped → name, portrait,
//      socials, ids; fetch the bio from the WP users API; park the blob.
//
// --approved (forwarded by harvest-links-loop.mjs) restricts Phases 1–2
// to directory artists (directory_status='approved'). Phase 0 seeding is
// DELIBERATELY NOT gated by it — discovering new pending artists is the
// whole point of HÖR, so the roster is always read.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/sync-hoer.mjs                 # seed + crawl + scrape (incremental)
//   node scripts/sync-hoer.mjs --approved      # Phases 1-2 only for approved artists (seeding still runs)
//   node scripts/sync-hoer.mjs --limit=20      # cap posts (Phase 1) and artists (Phase 2) — for testing
//   node scripts/sync-hoer.mjs --name="charlotte"  # Phase 2 only for artists whose name matches
//   node scripts/sync-hoer.mjs --force         # re-scrape artist pages already done
//   node scripts/sync-hoer.mjs --backfill      # revisit ALL artists; write only bio + socials + cache blob
//   node scripts/sync-hoer.mjs --debug         # verbose per-item logging
//   DRY_RUN=1 node scripts/sync-hoer.mjs       # fetch + log, no DB writes (cursor not advanced)
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY.
// (No HÖR token — its REST API and pages are public.)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordFailure, clearFailure, loadFailureUrls } from "./lib/harvest-failures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const STATE_SERVICE = "hoer-sync"; // resolved_artists.service / harvest_failures.service
const HOER_ORIGIN = "https://hoer.live";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const FORCE = args.includes("--force");
// --backfill: revisit artists already scraped and write ONLY the fields
// that a plain re-run would otherwise leave untouched or churn — the bio
// (now sourced from the WP user API) and socials (block-selection fix) —
// plus the api_response_cache harvest blob. Name/portrait writes are
// skipped (already correct; re-writing just bumps timestamps / re-hosts).
const BACKFILL = args.includes("--backfill");
// --approved: restrict enrichment (Phases 1-2) to directory artists.
// Seeding (Phase 0) always runs regardless — see module header.
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
if (!SUPABASE_URL || !SECRET_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } });

// ------------------------------------------------------------
// HÖR HTTP — throttled, with timeout and one retry on 429/5xx.
// Public site; be a polite ~3 req/s.
// ------------------------------------------------------------
const THROTTLE_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

// ------------------------------------------------------------
// Compact progress reporting. On an interactive terminal it rewrites a
// single line (carriage return) so a long run shows a live counter; when
// output is piped to a file/log it prints a fresh line each time instead
// (callers already rate-limit how often they call it, e.g. every N items).
// progressDone() ends the live line so the following summary sits clean.
// ------------------------------------------------------------
const IS_TTY = Boolean(process.stdout.isTTY);
function progress(msg) {
  if (IS_TTY) process.stdout.write(`\r${msg}[K`);
  else console.log(msg);
}
function progressDone() {
  if (IS_TTY) process.stdout.write("\n");
}

const UA = "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +profile enrichment)";

async function hoerFetch(url, { retried = false } = {}) {
  await throttle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      redirect: "follow",
    });
    if ((res.status === 429 || res.status >= 500) && !retried) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "5", 10);
      await sleep(Math.min(retryAfter, 30) * 1000);
      return hoerFetch(url, { retried: true });
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch a WP REST endpoint. Returns { ok, status, data }. A 400 with a
// page-out-of-range code is treated as "no more pages" (data = []).
async function hoerJson(pathAndQuery) {
  let res;
  try {
    res = await hoerFetch(`${HOER_ORIGIN}${pathAndQuery}`);
  } catch {
    return { ok: false, status: 0, data: null };
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const code = body?.code ?? "";
    if (/invalid_page_number|invalid_page/i.test(code)) return { ok: true, status: 400, data: [] };
    return { ok: false, status: 400, data: null };
  }
  if (!res.ok) return { ok: false, status: res.status, data: null };
  const data = await res.json().catch(() => null);
  return { ok: data != null, status: res.status, data };
}

// ------------------------------------------------------------
// Supabase pagination (PostgREST caps unpaginated queries at 1000 rows).
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
// URL classification for staged socials. Same per-script-copy
// convention as sync-discogs.mjs / integrate-harvested-links.mjs.
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
  /(^|\.)hoer\.(live|berlin)$/i, // self-links (identity link handled directly)
  /(^|\.)youtube\.com$/i, // HÖR set videos, not an artist channel signal here
  /(^|\.)youtu\.be$/i,
];
function normalizeUrl(url) {
  const u = new URL(url.toString());
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}
function classifyUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  for (const re of SKIP_HOST_REGEXES) if (re.test(host)) return null;
  if (host.endsWith(".wikipedia.org") || host === "wikipedia.org")
    return { platform: "wikipedia", parsedUrl: normalizeUrl(url) };
  for (const [re, platform] of DOMAIN_PLATFORM_MAP)
    if (re.test(host)) return { platform, parsedUrl: normalizeUrl(url) };
  return { platform: "other", parsedUrl: normalizeUrl(url) };
}

// ------------------------------------------------------------
// Slug / name helpers
// ------------------------------------------------------------
function slugFromArtistUrl(url) {
  const m = String(url).match(/\/artist\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}
// Placeholder display name used only until Phase 2 reads the real stage
// name from the page <h1>. NEVER the ppma_author `name` (that's the
// private legal name).
function slugToPlaceholderName(slug) {
  return slug
    .replace(/-\d+$/, "") // drop WP's uniqueness suffix (e.g. such-a-blurrr-2)
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ------------------------------------------------------------
// HTML → text helpers (raw-HTML parse; no DOM in Node here, same
// regex-based convention as sync-bandcamp.mjs).
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
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}
function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

// Parse a /artist/<slug>/ page. All selectors verified against the
// server-rendered HTML (2026-07-10). Any field may legitimately be
// absent (e.g. many artists have no portrait → no .artist__image div).
function parseArtistPage(html) {
  const stageNameRaw = firstMatch(
    html,
    /<h1\b[^>]*class="[^"]*\bartist__title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i
  );
  const stageName = stageNameRaw ? htmlToText(stageNameRaw).trim() : null;

  // WordPress user id. The /artist/<slug>/ page is a WP *author archive*;
  // the numeric user id is in the <body> class (`author-<id>`). It keys the
  // REST record where the bio actually lives — the page's own .artist__text
  // is an empty placeholder filled client-side by JS, so it is NEVER in the
  // server HTML we fetch (that is why an earlier version harvested 0 bios).
  // The bio itself is fetched in Phase 2 (async); see scrapeArtists().
  // Guest / orphan ppma_author terms have no author archive → no id → no bio.
  // NB: `author-<slug>` (e.g. author-2hot2play) also appears in the body
  // class; the trailing \b keeps \d+ from matching its leading digits.
  const wpUserId = firstMatch(
    html,
    /<body\b[^>]*\bclass="[^"]*\bauthor-(\d+)\b[^"]*"/i
  );

  // Portrait: an .artist__image div with inline background-image (class
  // and style can appear in either order). Absent div = no portrait.
  let imageUrl = null;
  const imgBlock =
    firstMatch(html, /<div\b[^>]*\bartist__image\b[^>]*style="([^"]*)"/i) ||
    firstMatch(html, /style="([^"]*background-image[^"]*)"[^>]*\bartist__image\b/i);
  if (imgBlock) {
    const um = imgBlock.match(/background-image:\s*url\((['"]?)([^)'"]+)\1\)/i);
    if (um) imageUrl = largestImageUrl(decodeEntities(um[2]));
  }

  // Socials: anchors inside .artist__socials. The page has TWO such blocks:
  // a JS-template placeholder (all href="") that appears FIRST, then the
  // real server-rendered block. Scan ALL blocks and keep only non-empty
  // hrefs (the placeholder's empties never match href="([^"]+)"), deduping
  // across blocks. An earlier version took only the first block → 0 socials.
  const socials = [];
  const seenSocial = new Set();
  const socialsBlockRe =
    /<div\b[^>]*class="[^"]*\bartist__socials\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let socialsBlock;
  while ((socialsBlock = socialsBlockRe.exec(html)) !== null) {
    const re = /href="([^"]+)"/gi;
    let m;
    while ((m = re.exec(socialsBlock[1])) !== null) {
      const href = decodeEntities(m[1]);
      if (!href.trim() || seenSocial.has(href)) continue;
      seenSocial.add(href);
      socials.push(href);
    }
  }

  // Location: best-effort only (rendered as a generic .btn with no
  // stable hook). Try an explicit class; otherwise leave null rather
  // than guess. Structured location is a future enhancement (same
  // status as it is for Bandcamp/Discogs).
  const locRaw = firstMatch(
    html,
    /<[^>]*class="[^"]*\bartist__location\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i
  );
  const location = locRaw ? htmlToText(locRaw) || null : null;

  return { stageName, wpUserId, imageUrl, socials, location };
}

// WordPress serves resized derivatives like Name-1024x1024.jpeg; strip a
// trailing -WxH so we store the original (the un-suffixed file always
// exists). '-scaled' is left intact (that IS the stored large original).
function largestImageUrl(url) {
  return url.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "");
}

// ============================================================
// Phase 0 — enumerate ppma_author, seed new artists + hoer links.
// ============================================================
async function enumerateAndSeed() {
  // 0a. Read HÖR's full artist roster from the API.
  const terms = [];
  for (let page = 1; ; page++) {
    const { ok, data } = await hoerJson(
      `/wp-json/wp/v2/ppma_author?per_page=100&page=${page}&_fields=id,slug,name,link,count`
    );
    if (!ok) {
      console.error(`  (ppma_author page ${page} failed — roster may be incomplete)`);
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    terms.push(...data);
    progress(`  Phase 0: reading roster… ${terms.length} term(s)`);
    if (data.length < 100) break;
  }
  progressDone();

  // 0b. Filter obvious junk terms (empty name AND zero posts — e.g. the
  // 'testtest'/'otyydrt' placeholder terms).
  const real = terms.filter(
    (t) => t.slug && !((!t.name || !String(t.name).trim()) && (t.count ?? 0) === 0)
  );
  const skipped = terms.length - real.length;

  // 0c. Existing hoer links → slug set, so we only insert new artists.
  const existingLinks = await fetchAll("artist_links", "id, artist_id, url, handle", (q) =>
    q.eq("platform", "hoer")
  );
  const existingSlugs = new Set();
  for (const row of existingLinks) {
    const slug = row.handle || slugFromArtistUrl(row.url);
    if (slug) existingSlugs.add(slug.toLowerCase());
  }

  let seeded = 0;
  let seedFailed = 0;
  let checked = 0;
  for (const t of real) {
    if (++checked % 100 === 0 || seeded % 50 === 49)
      progress(`  Phase 0: seeding… ${checked}/${real.length} checked, ${seeded} new artist(s)`);
    const slug = String(t.slug).toLowerCase();
    if (existingSlugs.has(slug)) continue;
    if (DRY_RUN) {
      if (DEBUG) console.log(`  ~ would seed ${slug}`);
      seeded++;
      continue;
    }
    const legalName = t.name && String(t.name).trim() ? String(t.name).trim() : null;
    const { data: inserted, error: insErr } = await supabase
      .from("artists")
      .insert({ name: slugToPlaceholderName(slug), directory_status: "pending" })
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error(`  (failed to seed artist ${slug}: ${insErr?.message ?? "no row"})`);
      seedFailed++;
      continue;
    }
    const canonicalUrl = t.link || `${HOER_ORIGIN}/artist/${slug}/`;
    const { error: linkErr } = await supabase
      .from("artist_links")
      .insert({ artist_id: inserted.id, platform: "hoer", url: canonicalUrl, handle: slug });
    if (linkErr) {
      console.error(`  (seeded ${slug} but failed to add hoer link: ${linkErr.message})`);
      seedFailed++;
      continue;
    }
    // Legal name (ppma_author.name) → private artist_legal_names table,
    // shared with sync-discogs. Captured once, here at seed time.
    if (legalName) {
      const { error: lnErr } = await supabase
        .from("artist_legal_names")
        .upsert(
          { artist_id: inserted.id, platform: "hoer", legal_name: legalName, source_url: canonicalUrl },
          { onConflict: "artist_id,platform" }
        );
      if (lnErr) console.error(`  (seeded ${slug} but failed to store legal name: ${lnErr.message})`);
    }
    existingSlugs.add(slug);
    seeded++;
  }
  progressDone();

  console.log(
    `Phase 0 (roster): ${terms.length} ppma_author term(s), ${real.length} real ` +
      `(${skipped} junk skipped); ${seeded} new artist(s) seeded` +
      (seedFailed ? `, ${seedFailed} seed failure(s)` : "") +
      (DRY_RUN ? " [dry run]" : "") +
      "."
  );

  // 0d. Complete termId → artist_id map (existing + newly seeded), plus
  // per-artist metadata for --approved gating and Phase 2 targeting.
  const hoerLinks = await fetchAll(
    "artist_links",
    "id, artist_id, url, handle, artists!inner(id, name, directory_status, deleted)",
    (q) => q.eq("platform", "hoer")
  );
  const slugToArtist = new Map(); // slug -> { artistId, status, deleted, name, url }
  for (const row of hoerLinks) {
    const slug = (row.handle || slugFromArtistUrl(row.url) || "").toLowerCase();
    if (!slug) continue;
    slugToArtist.set(slug, {
      artistId: row.artist_id,
      status: row.artists?.directory_status,
      deleted: row.artists?.deleted,
      name: row.artists?.name,
      url: row.url,
    });
  }
  const termIdToArtist = new Map(); // ppma_author id -> artistId
  for (const t of real) {
    const a = slugToArtist.get(String(t.slug).toLowerCase());
    if (a && !a.deleted) {
      termIdToArtist.set(t.id, a.artistId);
      a.ppmaAuthorId = t.id; // stamp onto the entry for the Phase 2 cache blob
    }
  }

  return { termIdToArtist, slugToArtist };
}

// ============================================================
// Phase 1 — crawl posts?after=<cursor>, stage genres + collaborations.
// ============================================================
async function readCursor() {
  const { data, error } = await supabase
    .from("hoer_sync_state")
    .select("last_set_date")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    console.error(`  (couldn't read hoer_sync_state cursor: ${error.message})`);
    return null;
  }
  return data?.last_set_date ?? null;
}
async function writeCursor(lastSetDate) {
  const { error } = await supabase
    .from("hoer_sync_state")
    .upsert(
      { id: true, last_set_date: lastSetDate, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  if (error) console.error(`  (couldn't write hoer_sync_state cursor: ${error.message})`);
}

async function loadTagMap() {
  const map = new Map(); // tag id -> name
  for (let page = 1; ; page++) {
    const { ok, data } = await hoerJson(
      `/wp-json/wp/v2/tags?per_page=100&page=${page}&_fields=id,name`
    );
    if (!ok || !Array.isArray(data) || data.length === 0) break;
    for (const t of data) if (t.id != null && t.name) map.set(t.id, decodeEntities(String(t.name)));
    if (data.length < 100) break;
  }
  return map;
}

async function crawlSets(termIdToArtist, slugToArtist) {
  const cursor = await readCursor();
  console.log(
    `Phase 1 (sets): crawling posts${cursor ? ` after ${cursor}` : " (full backfill — no cursor yet)"}` +
      `${APPROVED_ONLY ? ", approved artists only" : ""}.`
  );
  const tagMap = await loadTagMap();

  const approvedArtistIds = new Set();
  if (APPROVED_ONLY) {
    for (const a of slugToArtist.values())
      if (a.status === "approved" && !a.deleted) approvedArtistIds.add(a.artistId);
  }
  const isEligible = (artistId) => !APPROVED_ONLY || approvedArtistIds.has(artistId);

  const genreRows = new Map(); // "artistId|rawtag" -> {artist_id, source_platform, raw_tag}
  const collabPairs = []; // [idA, idB] per shared set (each set counted once)
  let maxDate = cursor;
  let postCount = 0;
  let limited = false;

  outer: for (let page = 1; ; page++) {
    const after = cursor ? `&after=${encodeURIComponent(cursor)}` : "";
    const { ok, data } = await hoerJson(
      `/wp-json/wp/v2/posts?per_page=100&page=${page}&orderby=date&order=asc&_fields=id,date,tags,ppma_author${after}`
    );
    if (!ok) {
      console.error(`  (posts page ${page} failed — stopping crawl)`);
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;

    for (const post of data) {
      const authorIds = (Array.isArray(post.ppma_author) ? post.ppma_author : [])
        .map((tid) => termIdToArtist.get(tid))
        .filter((id) => id && isEligible(id));
      const uniqueAuthors = [...new Set(authorIds)];
      const genreNames = (Array.isArray(post.tags) ? post.tags : [])
        .map((tid) => tagMap.get(tid))
        .filter(Boolean);

      for (const artistId of uniqueAuthors) {
        for (const g of genreNames) {
          const raw = g.toLowerCase().trim();
          if (!raw) continue;
          genreRows.set(`${artistId}|${raw}`, {
            artist_id: artistId,
            source_platform: "hoer",
            raw_tag: raw,
          });
        }
      }
      // A set credited to >=2 of our artists = one collaboration event.
      for (let i = 0; i < uniqueAuthors.length; i++)
        for (let j = i + 1; j < uniqueAuthors.length; j++)
          collabPairs.push([uniqueAuthors[i], uniqueAuthors[j]]);

      if (post.date && (!maxDate || post.date > maxDate)) maxDate = post.date;
      postCount++;
      if (LIMIT && postCount >= LIMIT) {
        limited = true;
        break outer;
      }
    }
    progress(`  Phase 1: crawling sets… ${postCount} read (page ${page})`);
    if (data.length < 100) break;
  }
  progressDone();

  // Stage genres in chunks.
  let stagedGenres = 0;
  const genreList = [...genreRows.values()];
  if (!DRY_RUN && genreList.length) {
    for (let i = 0; i < genreList.length; i += 500) {
      const chunk = genreList.slice(i, i + 500);
      const { error } = await supabase
        .from("artist_harvested_genres")
        .upsert(chunk, { onConflict: "artist_id,source_platform,raw_tag", ignoreDuplicates: true });
      if (error) console.error(`  (genre stage chunk failed: ${error.message})`);
      else stagedGenres += chunk.length;
    }
  }

  // Collaboration edges (each shared set = +1 to collab_count).
  let collabEdges = 0;
  if (!DRY_RUN && collabPairs.length) {
    let done = 0;
    for (const [a, b] of collabPairs) {
      if (await upsertCollab(a, b)) collabEdges++;
      if (++done % 50 === 0)
        progress(`  Phase 1: writing collab edges… ${done}/${collabPairs.length}`);
    }
    progressDone();
  }

  // Advance the cursor — but NOT when --limit truncated the crawl (we'd
  // skip the un-crawled remainder forever), and never on a dry run.
  if (!DRY_RUN && maxDate && maxDate !== cursor && !limited) {
    await writeCursor(maxDate);
  }

  console.log(
    `Phase 1 result: ${postCount} set(s) read${limited ? " (--limit reached — cursor NOT advanced)" : ""}; ` +
      `${DRY_RUN ? genreList.length + " genre row(s) (dry)" : stagedGenres + " genre row(s) staged"}, ` +
      `${DRY_RUN ? collabPairs.length + " collab pair(s) (dry)" : collabEdges + " collab edge(s)"}` +
      (maxDate && maxDate !== cursor && !limited && !DRY_RUN ? `; cursor → ${maxDate}` : "") +
      "."
  );
}

// Undirected collaboration edge (artist_id_a < artist_id_b per the table
// CHECK), source_platform='hoer'; increments collab_count on conflict.
// Copied from sync-discogs.mjs / enrich-musicbrainz.mjs.
async function upsertCollab(idA, idB) {
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
  const { error: insertErr } = await supabase
    .from("collaborations")
    .insert({ artist_id_a: lo, artist_id_b: hi, collab_count: 1, source_platform: "hoer" });
  if (!insertErr) return true;
  if (insertErr.code === "23505") {
    const { data: existing, error: selErr } = await supabase
      .from("collaborations")
      .select("id, collab_count")
      .eq("artist_id_a", lo)
      .eq("artist_id_b", hi)
      .eq("source_platform", "hoer")
      .single();
    if (selErr) {
      console.error(`  (collab select failed: ${selErr.message})`);
      return false;
    }
    const { error: updErr } = await supabase
      .from("collaborations")
      .update({ collab_count: existing.collab_count + 1 })
      .eq("id", existing.id);
    if (updErr) {
      console.error(`  (collab update failed: ${updErr.message})`);
      return false;
    }
    return true;
  }
  console.error(`  (collab insert failed: ${insertErr.message})`);
  return false;
}

// ============================================================
// Phase 2 — scrape /artist/<slug>/ pages, fan out name/bio/image/socials.
// ============================================================
async function scrapeArtists(slugToArtist) {
  // Already-scraped state from the DB (paginated).
  const processed = new Set();
  {
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("resolved_artists")
        .select("artist_id")
        .eq("service", STATE_SERVICE)
        .order("artist_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      for (const r of data ?? []) processed.add(r.artist_id);
      if ((data?.length ?? 0) < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }
  // Link-changed cross-check (mirrors sync-discogs.mjs): an artist marked
  // processed on a 404 is retried automatically once its hoer link changes.
  const failureUrls = await loadFailureUrls(supabase, { service: STATE_SERVICE });

  let targets = [];
  for (const [slug, a] of slugToArtist) {
    if (a.deleted) continue;
    if (APPROVED_ONLY && a.status !== "approved") continue;
    if (NAME_FILTER && !(a.name ?? "").toLowerCase().includes(NAME_FILTER.toLowerCase())) continue;
    if (!FORCE && !BACKFILL && processed.has(a.artistId)) {
      const failedUrl = failureUrls.get(a.artistId);
      if (!(failedUrl != null && failedUrl !== a.url)) continue; // still processed → skip
    }
    targets.push({ slug, ...a });
  }
  const skippedProcessed = slugToArtist.size - targets.length;
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(
    `Phase 2 (pages): ${targets.length} artist page(s) to scrape` +
      (skippedProcessed > 0 && !FORCE && !BACKFILL ? ` (${skippedProcessed} already done)` : "") +
      (BACKFILL ? ", backfill (bio + socials + cache blob only)" : "") +
      (APPROVED_ONLY ? ", approved only" : "") +
      "."
  );

  const stats = { name: 0, bios: 0, images: 0, links: 0, noImage: 0, failed: 0, ok: 0 };

  let done = 0;
  for (const t of targets) {
    if (++done % 10 === 0 || done === targets.length)
      progress(
        `  Phase 2: scraping pages… ${done}/${targets.length} — ` +
          `${stats.ok} ok, ${stats.images} image(s), ${stats.failed} failed`
      );
    const artistId = t.artistId;
    const pageUrl = t.url || `${HOER_ORIGIN}/artist/${t.slug}/`;
    let res;
    try {
      res = await hoerFetch(pageUrl);
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      console.log(`✗ ${t.slug}: HÖR HTTP ${status}`);
      stats.failed++;
      if (!DRY_RUN) {
        const is404 = status === 404;
        await recordFailure(supabase, {
          artistId,
          service: STATE_SERVICE,
          status: is404 ? "page_404" : "fetch_failed",
          detail: `HÖR HTTP ${status}`,
          url: pageUrl,
        });
        if (is404) await markProcessed(artistId); // definitive dead page → converge
      }
      continue;
    }
    const html = await res.text();
    const parsed = parseArtistPage(html);

    // Bio lives on the WP *user* record and is injected into the page by
    // JS at runtime — it is NOT in the server HTML. Fetch it from the REST
    // API keyed by the id parsed from the page. No id (guest/orphan term)
    // or no user record → no bio. The full user record is also parked in
    // the api_response_cache blob below for future mining.
    let wpUser = null;
    let bio = null;
    if (parsed.wpUserId) {
      const { ok, data } = await hoerJson(`/wp-json/wp/v2/users/${parsed.wpUserId}`);
      if (ok && data && !Array.isArray(data)) {
        wpUser = data;
        const rawDesc = typeof data.description === "string" ? data.description : "";
        // htmlToText decodes entities + strips WP markup; normalize CRLF first.
        const text = rawDesc ? htmlToText(rawDesc.replace(/\r\n?/g, "\n")) : "";
        bio = text || null;
      }
    }

    if (DRY_RUN) {
      if (DEBUG)
        console.log(
          `~ ${t.slug}: name=${parsed.stageName ?? "—"}, bio=${bio ? "yes" : "no"}, ` +
            `image=${parsed.imageUrl ? "yes" : "no"}, socials=${parsed.socials.length}`
        );
      stats.ok++;
      continue;
    }

    let allWritesOk = true;
    const writeFailed = (label, err) => {
      allWritesOk = false;
      console.error(`  (${t.slug}: ${label} failed: ${err?.message ?? err})`);
    };

    // Stage name → artists.name (replaces the seed placeholder). Skipped in
    // --backfill: names were captured on the original run and re-writing
    // them is churn (this run targets bio + socials + the cache blob).
    if (!BACKFILL && parsed.stageName) {
      const { error } = await supabase
        .from("artists")
        .update({ name: parsed.stageName })
        .eq("id", artistId);
      if (error) writeFailed("name", error);
      else stats.name++;
    }

    // Bio → biographies (platform='hoer') + artist_harvested_bios (raw).
    // Source is the WP user record (fetched above), not the page HTML.
    if (bio) {
      const { error: bioErr } = await supabase
        .from("biographies")
        .upsert(
          { artist_id: artistId, platform: "hoer", bio, source_url: pageUrl },
          { onConflict: "artist_id,platform" }
        );
      if (bioErr) writeFailed("biography", bioErr);
      else stats.bios++;
      const { error: rawErr } = await supabase
        .from("artist_harvested_bios")
        .upsert(
          { artist_id: artistId, source_platform: "hoer", source_url: pageUrl, raw_bio: bio },
          { onConflict: "artist_id,source_platform" }
        );
      if (rawErr) writeFailed("raw bio audit", rawErr);
    }

    // Portrait → artist_images (platform='hoer'); store-images.mjs re-hosts.
    // Skipped in --backfill (already captured; re-writing bumps fetched_at
    // and can re-trigger re-hosting).
    if (!BACKFILL && parsed.imageUrl) {
      const { error } = await supabase.from("artist_images").upsert(
        {
          artist_id: artistId,
          platform: "hoer",
          source_url: parsed.imageUrl,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "artist_id,platform" }
      );
      if (error) writeFailed("artist_images", error);
      else stats.images++;
    } else if (!parsed.imageUrl) {
      stats.noImage++;
    }

    // Socials → artist_harvested_links (staged; integrate promotes).
    const candidates = [];
    const seen = new Set();
    for (const rawUrl of parsed.socials) {
      const c = classifyUrl(rawUrl);
      if (!c) continue;
      const key = `${c.platform}|${c.parsedUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        artist_id: artistId,
        source_platform: "hoer",
        source_url: pageUrl,
        raw_url: rawUrl,
        parsed_platform: c.platform,
        parsed_url: c.parsedUrl,
      });
    }
    if (candidates.length) {
      const { data: ins, error } = await supabase
        .from("artist_harvested_links")
        .upsert(candidates, { onConflict: "artist_id,parsed_url", ignoreDuplicates: true })
        .select("id");
      if (error) writeFailed("staging links", error);
      else stats.links += ins?.length ?? 0;
    }

    // Durable harvest blob → api_response_cache (namespace 'hoer-artist',
    // key = slug). HÖR exposes no single per-artist API payload, so we
    // assemble one: the raw WP user record + the fields parsed from the page
    // + the ids (WP user id, ppma_author term id). This lets any field we
    // don't extract yet be mined later without re-scraping — the same durable
    // "park the whole payload" role sync-discogs.mjs uses for 'discogs-artist'.
    // Keyed on slug (universal + stable, matches artist_links.handle); the
    // WP user id isn't universal (guest/orphan terms lack one). See
    // supabase_migration_api_response_cache.sql.
    {
      const payload = {
        slug: t.slug,
        wp_user_id: parsed.wpUserId ? Number(parsed.wpUserId) : null,
        ppma_author_id: t.ppmaAuthorId ?? null,
        canonical_url: pageUrl,
        extracted: {
          stageName: parsed.stageName ?? null,
          bio,
          imageUrl: parsed.imageUrl ?? null,
          socials: parsed.socials,
          location: parsed.location ?? null,
        },
        wp_user: wpUser,
      };
      const { error } = await supabase
        .from("api_response_cache")
        .upsert(
          {
            namespace: "hoer-artist",
            cache_key: t.slug,
            payload,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "namespace,cache_key" }
        );
      if (error) writeFailed("cache blob", error);
    }

    if (allWritesOk) {
      await clearFailure(supabase, { artistId, service: STATE_SERVICE });
      await markProcessed(artistId);
      stats.ok++;
      if (DEBUG)
        console.log(
          `✓ ${t.slug}: ${parsed.stageName ?? "(no name)"}${bio ? ", bio" : ""}` +
            `${parsed.imageUrl ? ", image" : ""}${candidates.length ? `, ${candidates.length} social(s)` : ""}`
        );
    } else {
      stats.failed++;
      await recordFailure(supabase, {
        artistId,
        service: STATE_SERVICE,
        status: "write_failed",
        detail: "one or more writes failed",
        url: pageUrl,
      });
    }
  }
  progressDone();

  console.log(
    `Phase 2 result: ${stats.ok} page(s) ok — ${stats.name} name(s), ${stats.bios} bio(s), ` +
      `${stats.images} image(s) (${stats.noImage} without), ${stats.links} social link(s) staged, ` +
      `${stats.failed} failure(s).`
  );
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

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(DRY_RUN ? "sync-hoer — DRY RUN (no writes)\n" : "sync-hoer — syncing from HÖR\n");
  if (APPROVED_ONLY) console.log("--approved: Phases 1-2 restricted to directory artists (seeding still runs).\n");

  const { termIdToArtist, slugToArtist } = await enumerateAndSeed();
  await crawlSets(termIdToArtist, slugToArtist);
  await scrapeArtists(slugToArtist);

  if (!DRY_RUN) {
    console.log(
      "\nNext: integrate-harvested-genres.mjs (genres), integrate-harvested-links.mjs (socials), " +
        "store-images.mjs (re-host portraits)."
    );
  }
}

main().catch((err) => {
  console.error("\nsync-hoer failed:", err?.message ?? err);
  process.exit(1);
});
