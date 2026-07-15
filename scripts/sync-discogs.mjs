#!/usr/bin/env node
// ============================================================
// Phase 2c: sync-discogs.mjs — one-call Discogs sync.
//
// The Discogs analog of sync-soundcloud.mjs / sync-bandcamp.mjs, and
// the successor to harvest-links-discogs.mjs (which only staged links).
// For each artist with a Discogs link, it makes ONE call to the
// official Discogs API (GET /artists/{id}) and fans the single
// response out to every concern that resource can answer:
//
//   - External links (`urls`)      → staged into artist_harvested_links
//                                     (never written to artist_links
//                                     directly; integrate-harvested-
//                                     links.mjs / 2d promotes them).
//   - Alt name spellings           → artist_aliases (namevariations
//     (`namevariations`)             only — Discogs `aliases`, which are
//                                     separate personas/side-projects,
//                                     are deliberately NOT written).
//   - Real name (`realname`)       → artist_legal_names (platform=
//                                     'discogs'); a PRIVATE table (no
//                                     public read — see
//                                     supabase_migration_artist_legal_names.sql).
//                                     Never shown publicly. Shared with
//                                     HÖR's legal-name capture (sync-hoer).
//   - Profile text (`profile`)     → biographies (platform='discogs'),
//                                     cleaned of Discogs markup; the raw
//                                     text also goes to
//                                     artist_harvested_bios as an audit
//                                     trail (same as SoundCloud/Bandcamp).
//   - Group membership             → collaborations (source_platform=
//     (`members` / `groups`)         'discogs'), one undirected edge per
//                                     pair, but ONLY when the related
//                                     Discogs artist is also in our DB
//                                     (matched via its own Discogs link).
//                                     Mirrors enrich-musicbrainz.mjs.
//   - The FULL raw response        → api_response_cache (namespace
//                                     'discogs-artist', cache_key = numeric
//                                     Discogs id). A durable, TTL-less blob so
//                                     fields we don't extract yet (`aliases`,
//                                     `images`, `data_quality`, ...) can be
//                                     mined later without re-calling the API.
//
// Because it stages links like any harvester, it is a full member of
// the 2c/2d convergence loop (harvest-links-loop.mjs).
//
// Processed state lives in the DATABASE (resolved_artists, service =
// 'discogs-sync' — a NEW service, distinct from the old harvester's
// 'discogs-links', so this expanded sync re-processes everyone once to
// capture the new fields; the old 'discogs-links' rows are harmless and
// simply go unused). Failures go to harvest_failures (service =
// 'discogs-sync') via scripts/lib/harvest-failures.mjs, and a
// link-changed cross-check retries an artist automatically once a human
// fixes a link that had 404'd or was wrong-field, without --force.
//
// Old-format Discogs links carry a name instead of a numeric id
// (e.g. /artist/Bruno+Pronsato); those are resolved to /artist/<id> via
// the authenticated Discogs SEARCH API and rewritten back to
// artist_links so later runs skip the round-trip. See
// searchDiscogsArtistId / discogsPathInfo.
//
// Rate limit: 60 requests/minute authenticated (throttled to ~55/min).
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/sync-discogs.mjs                 # all unprocessed artists with a discogs link
//   node scripts/sync-discogs.mjs --approved      # only directory artists (directory_status = 'approved')
//   node scripts/sync-discogs.mjs --limit=20      # only the first 20 (for testing)
//   node scripts/sync-discogs.mjs --name="Danz"   # artists whose name contains this
//   node scripts/sync-discogs.mjs --force         # re-process even artists with a state row
//   node scripts/sync-discogs.mjs --debug         # log every URL/field classified
//   DRY_RUN=1 node scripts/sync-discogs.mjs       # fetch + log, no DB writes
//
// Requires .env.local:
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, DISCOGS_TOKEN
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordFailure, clearFailure, loadFailureUrls } from "./lib/harvest-failures.mjs";
import { canonicalizeResidentAdvisorUrl } from "./lib/ra-url.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const STATE_SERVICE = "discogs-sync"; // resolved_artists.service / harvest_failures.service

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const FORCE = args.includes("--force");
// --approved: only process artists in the live directory
// (directory_status = 'approved'). Lets the convergence loop and the
// orchestrator restrict every stage to directory artists with one flag.
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
// integrate-harvested-links.mjs / sync-soundcloud.mjs. discogs.com
// self-links, Twitter/X (project policy), and wikidata.org are skipped.
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
  // Rewrite pre-rebrand residentadvisor.net links onto ra.co up front, so
  // both the platform match and the stored parsed_url use the current host.
  rawUrl = canonicalizeResidentAdvisorUrl(rawUrl);
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

// Break a Discogs URL into { kind, slug }. `kind` is the resource type
// ("artist", "label", "user", "release", ...); `slug` is the first path
// segment after it. Handles a locale prefix like /de/ or /it/.
function discogsPathInfo(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)discogs\.com$/i.test(u.hostname)) return null;
  const p = u.pathname.replace(/^\/[a-z]{2}(?=\/)/i, ""); // drop /xx/ locale
  const seg = p.split("/").filter(Boolean);
  if (seg.length < 2) return { kind: seg[0]?.toLowerCase() ?? "other", slug: "" };
  return { kind: seg[0].toLowerCase(), slug: seg[1] };
}

// Old-format artist URLs carry the name as the slug (e.g. /artist/Bruno+Pronsato,
// or double-encoded /artist/Violet+%252814%2529). Recover the human name:
// fully decode (undo double/triple encoding), then turn "+" into spaces.
function decodeDiscogsName(slug) {
  let s = slug;
  for (let i = 0; i < 3; i++) {
    let next;
    try {
      next = decodeURIComponent(s);
    } catch {
      break; // malformed escape — stop decoding
    }
    if (next === s) break;
    s = next;
  }
  return s.replace(/\+/g, " ").trim();
}

// Resolve a name-based artist URL to a numeric id via the authenticated
// Discogs search API. We only accept an EXACT name match, so we never
// guess a wrong artist; anything ambiguous stays unresolved.
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

async function searchDiscogsArtistId(name) {
  const target = norm(name);
  if (!target) return null;
  const base = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const queries = base && norm(base) !== target ? [name, base] : [name];

  for (const q of queries) {
    await throttle();
    let res;
    try {
      res = await fetch(
        `https://api.discogs.com/database/search?type=artist&per_page=100&q=${encodeURIComponent(q)}`,
        {
          headers: {
            "User-Agent": "RebalanceGender/1.0 +https://rebalance-gender.com",
            Authorization: `Discogs token=${DISCOGS_TOKEN}`,
          },
        }
      );
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const hit = results.find((r) => r.id && norm(r.title) === target);
    if (hit) return String(hit.id);
  }
  return null;
}

// ------------------------------------------------------------
// Discogs profile markup → plain text.
// Discogs bios use BBCode-ish tags: [a=Name]/[l=Name] references,
// [a123]/[l123]/[m123] numeric references, [url=..]label[/url], and
// [b]/[i]/[u]. Keep the human-readable inner text, drop the tags. The
// raw text is preserved verbatim in artist_harvested_bios regardless.
// ------------------------------------------------------------
function cleanDiscogsProfile(text) {
  if (!text) return "";
  let s = String(text);
  s = s.replace(/\[(?:a|l|b|m)=([^\]]+)\]/gi, "$1"); // [a=Name] -> Name
  s = s.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, "$1"); // [url=..]label[/url] -> label
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, "$1"); // [url]http[/url] -> http
  s = s.replace(/\[(?:a|l|m)\d+\]/gi, ""); // numeric refs -> drop
  s = s.replace(/\[\/?(?:b|i|u)\]/gi, ""); // formatting tags -> drop
  s = s.replace(/\[\/?[a-z][^\]]*\]/gi, ""); // any leftover tag -> drop
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Syncing artists from Discogs\n");

  // Artists with a discogs link (first link per artist wins, by id).
  const discogsLinks = await fetchAll(
    "artist_links",
    "id, artist_id, url, artists!inner(id, name)",
    (q) => {
      q = q.eq("platform", "discogs");
      if (APPROVED_ONLY) q = q.eq("artists.directory_status", "approved").eq("artists.deleted", false);
      if (NAME_FILTER) q = q.ilike("artists.name", `%${NAME_FILTER}%`);
      return q;
    }
  );

  const byArtist = new Map();
  for (const row of discogsLinks) {
    if (!byArtist.has(row.artist_id)) byArtist.set(row.artist_id, row);
  }

  // Discogs numeric id → our artist_id, for turning `members`/`groups`
  // into collaboration edges. Built from EVERY artist's discogs link
  // (not just the approved subset), mirroring enrich-musicbrainz.mjs,
  // which links to any related artist that exists in our DB.
  const discogsIdToArtist = new Map();
  {
    const allDiscogsLinks = await fetchAll("artist_links", "id, artist_id, url", (q) =>
      q.eq("platform", "discogs")
    );
    for (const row of allDiscogsLinks) {
      const id = discogsArtistIdFromUrl(row.url);
      if (id && !discogsIdToArtist.has(id)) discogsIdToArtist.set(id, row.artist_id);
    }
  }

  // Already-processed state from the DB (paginated).
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

  // Link-changed cross-check: an artist marked processed on a 404 or
  // wrong-field failure is otherwise skipped forever (resolved_artists
  // tracks only "done for this artist_id", not which URL was checked).
  // If the artist's current Discogs link differs from the one recorded
  // at failure time, retry it — no --force needed.
  const failureUrls = await loadFailureUrls(supabase, { service: STATE_SERVICE });

  let targets = [...byArtist.values()].filter((row) => {
    if (FORCE) return true;
    if (!processed.has(row.artist_id)) return true;
    const failedUrl = failureUrls.get(row.artist_id);
    return failedUrl != null && failedUrl !== row.url; // link changed since it failed
  });
  const skippedProcessed = byArtist.size - targets.length;
  if (LIMIT) targets = targets.slice(0, LIMIT);

  if (APPROVED_ONLY) {
    console.log("--approved: restricting to directory artists (directory_status = 'approved').");
  }
  console.log(`${byArtist.size} ${APPROVED_ONLY ? "approved " : ""}artist(s) have a Discogs link.`);
  if (skippedProcessed > 0 && !FORCE) {
    console.log(`${skippedProcessed} already processed (state in resolved_artists; use --force to redo).`);
  }
  console.log(`${targets.length} to process.\n`);

  const stats = {
    staged: 0,
    aliases: 0,
    bios: 0,
    realnames: 0,
    collabs: 0,
    noUrls: 0,
    failed: 0,
    skippedNonArtist: 0,
    resolvedOld: 0,
  };
  const stagedByPlatform = {};

  for (const row of targets) {
    const artistId = row.artist_id;
    const name = row.artists?.name ?? artistId;
    let discogsId = discogsArtistIdFromUrl(row.url);

    if (!discogsId) {
      const info = discogsPathInfo(row.url);

      // Not an artist URL (user profile, label, release, ...). No artist
      // id can ever exist — a wrong-field link. Mark processed (it won't
      // fix itself), but the cross-check above retries if a human fixes it.
      if (info && info.kind !== "artist") {
        console.log(`· ${name}: wrong-field Discogs URL (${info.kind}): ${row.url}`);
        stats.skippedNonArtist++;
        if (!DRY_RUN) {
          await recordFailure(supabase, {
            artistId,
            service: STATE_SERVICE,
            status: "wrong_field_url",
            detail: `non-artist Discogs URL (${info.kind})`,
            url: row.url,
          });
          await markProcessed(artistId);
        }
        continue;
      }

      // Old-format, name-based artist URL — resolve to a numeric id.
      const wantedName = info?.slug ? decodeDiscogsName(info.slug) : (row.artists?.name ?? "");
      const resolvedId = wantedName ? await searchDiscogsArtistId(wantedName) : null;
      if (!resolvedId) {
        console.log(`✗ ${name}: could not resolve artist id from ${row.url}`);
        stats.failed++;
        if (!DRY_RUN) {
          await recordFailure(supabase, {
            artistId,
            service: STATE_SERVICE,
            status: "resolve_failed",
            detail: "could not resolve old-format Discogs URL to an id",
            url: row.url,
          });
        }
        continue; // leave unmarked — a later run (or link fix) can retry
      }
      const canonicalUrl = `https://www.discogs.com/artist/${resolvedId}`;
      console.log(`  ↳ ${name}: resolved ${row.url} → ${canonicalUrl} (name "${wantedName}")`);
      discogsId = resolvedId;
      stats.resolvedOld++;
      if (!DRY_RUN && canonicalUrl !== row.url) {
        const { error: updErr } = await supabase
          .from("artist_links")
          .update({ url: canonicalUrl })
          .eq("id", row.id);
        if (updErr) {
          if (updErr.code === "23505") {
            const { error: delErr } = await supabase.from("artist_links").delete().eq("id", row.id);
            if (delErr) {
              console.error(`  (couldn't remove old-format artist_links row for ${name}: ${delErr.message})`);
            } else {
              console.log(`  ↳ ${name}: canonical URL already present — removed old-format row`);
            }
          } else {
            console.error(`  (couldn't update artist_links url for ${name}: ${updErr.message})`);
          }
        }
        row.url = canonicalUrl; // so a same-run failure records the canonical url
      }
    }

    const res = await fetchDiscogsArtist(discogsId);
    if (!res.ok) {
      console.log(`✗ ${name}: Discogs HTTP ${res.status} for artist ${discogsId}`);
      stats.failed++;
      if (!DRY_RUN) {
        const is404 = res.status === 404;
        await recordFailure(supabase, {
          artistId,
          service: STATE_SERVICE,
          status: is404 ? "resolve_404" : "resolve_failed",
          detail: `Discogs HTTP ${res.status}`,
          url: row.url,
        });
        // 404 is a definitive dead link — mark processed so the loop can
        // converge (cross-check retries if the link is later corrected).
        // Other statuses (5xx, network) are possibly transient — leave
        // unmarked to retry next run.
        if (is404) await markProcessed(artistId);
      }
      continue;
    }

    const data = res.data ?? {};

    // Track whether every write for this artist succeeded; only then do
    // we mark it processed. A failed write leaves it unmarked so the
    // (idempotent) writes retry next run.
    let allWritesOk = true;
    const writeFailed = (label, err) => {
      allWritesOk = false;
      console.error(`  (${name}: ${label} failed: ${err?.message ?? err})`);
    };

    // ---- Full response → api_response_cache (durable blob) ----
    // Park the entire artist payload keyed by its Discogs id so fields we
    // don't extract yet (e.g. `aliases`, `images`, `data_quality`) can be
    // mined later without re-calling the rate-limited API. The table has no
    // TTL, so these rows persist. Keyed on the numeric Discogs id (stable
    // across old-format URL rewrites), not artist_id, so it doubles as a
    // by-id response cache. See supabase_migration_api_response_cache.sql.
    if (!DRY_RUN) {
      const { error } = await supabase
        .from("api_response_cache")
        .upsert(
          {
            namespace: "discogs-artist",
            cache_key: String(discogsId),
            payload: data,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "namespace,cache_key" }
        );
      if (error) writeFailed("cache blob", error);
    }

    // ---- Links → artist_harvested_links (staged) ----
    const urls = Array.isArray(data.urls) ? data.urls : [];
    const candidates = [];
    for (const rawUrl of urls) {
      const classified = classifyUrl(rawUrl);
      if (!classified) {
        if (DEBUG) console.log(`    (skipped url: ${rawUrl})`);
        continue;
      }
      candidates.push({
        artist_id: artistId,
        source_platform: "discogs",
        source_url: row.url,
        raw_url: rawUrl,
        parsed_platform: classified.platform,
        parsed_url: classified.parsedUrl,
      });
      if (DEBUG) console.log(`    link ${classified.platform.padEnd(16)} ${classified.parsedUrl}`);
    }
    let newLinkCount = 0;
    if (candidates.length && !DRY_RUN) {
      const { data: inserted, error } = await supabase
        .from("artist_harvested_links")
        .upsert(candidates, { onConflict: "artist_id,parsed_url", ignoreDuplicates: true })
        .select("id, parsed_platform");
      if (error) {
        writeFailed("staging links", error);
      } else {
        const newRows = inserted ?? [];
        newLinkCount = newRows.length;
        stats.staged += newRows.length;
        for (const r of newRows) {
          stagedByPlatform[r.parsed_platform] = (stagedByPlatform[r.parsed_platform] ?? 0) + 1;
        }
      }
    }

    // ---- Real name → artist_legal_names (private table) ----
    const realname = typeof data.realname === "string" ? data.realname.trim() : "";
    if (realname && !DRY_RUN) {
      const { error } = await supabase
        .from("artist_legal_names")
        .upsert(
          { artist_id: artistId, platform: "discogs", legal_name: realname, source_url: row.url },
          { onConflict: "artist_id,platform" }
        );
      if (error) writeFailed("legal name", error);
      else stats.realnames++;
    } else if (realname && DEBUG) {
      console.log(`    legal name (private): ${realname}`);
    }

    // ---- Name variations → artist_aliases (public, searchable) ----
    // Only `namevariations` (alt spellings). `aliases` (separate
    // personas/side-projects) are deliberately not written.
    const variations = Array.isArray(data.namevariations) ? data.namevariations : [];
    const newAliases = await pickNewAliases(artistId, name, variations);
    if (newAliases.length && !DRY_RUN) {
      const { error } = await supabase
        .from("artist_aliases")
        .insert(newAliases.map((n) => ({ artist_id: artistId, name: n })));
      if (error) writeFailed("aliases", error);
      else stats.aliases += newAliases.length;
    } else if (newAliases.length && DEBUG) {
      console.log(`    aliases: ${newAliases.join(" | ")}`);
    }

    // ---- Profile → biographies (cleaned) + artist_harvested_bios (raw) ----
    const rawProfile = typeof data.profile === "string" ? data.profile.trim() : "";
    if (rawProfile && !DRY_RUN) {
      const cleaned = cleanDiscogsProfile(rawProfile);
      const { error: bioErr } = await supabase
        .from("biographies")
        .upsert(
          { artist_id: artistId, platform: "discogs", bio: cleaned, source_url: row.url },
          { onConflict: "artist_id,platform" }
        );
      if (bioErr) writeFailed("biography", bioErr);
      else stats.bios++;

      const { error: rawErr } = await supabase
        .from("artist_harvested_bios")
        .upsert(
          { artist_id: artistId, source_platform: "discogs", source_url: row.url, raw_bio: rawProfile },
          { onConflict: "artist_id,source_platform" }
        );
      if (rawErr) writeFailed("raw bio audit", rawErr);
    } else if (rawProfile && DEBUG) {
      console.log(`    bio: ${cleanDiscogsProfile(rawProfile).slice(0, 80)}...`);
    }

    // ---- Membership → collaborations (source_platform='discogs') ----
    // `members` (this entity is a group → its members) and `groups`
    // (this entity is in these bands). Edge only when the related
    // Discogs artist is also in our DB.
    const related = [
      ...(Array.isArray(data.members) ? data.members : []),
      ...(Array.isArray(data.groups) ? data.groups : []),
    ];
    const collabPartnerIds = new Set();
    for (const m of related) {
      const otherArtistId = m?.id != null ? discogsIdToArtist.get(String(m.id)) : null;
      if (otherArtistId && otherArtistId !== artistId) collabPartnerIds.add(otherArtistId);
    }
    for (const otherArtistId of collabPartnerIds) {
      if (DRY_RUN) {
        if (DEBUG) console.log(`    collab: ${artistId} ↔ ${otherArtistId}`);
        continue;
      }
      const ok = await upsertCollab(artistId, otherArtistId);
      if (ok) stats.collabs++;
      else allWritesOk = false;
    }

    if (candidates.length === 0) stats.noUrls++;

    if (DRY_RUN) {
      console.log(
        `~ ${name}: would sync (${candidates.length} link(s), ${newAliases.length} alias(es), ` +
          `${rawProfile ? "bio, " : ""}${realname ? "realname, " : ""}${collabPartnerIds.size} collab(s))`
      );
      continue;
    }

    if (allWritesOk) {
      await clearFailure(supabase, { artistId, service: STATE_SERVICE });
      await markProcessed(artistId);
      console.log(
        `✓ ${name}: ${newLinkCount} new link(s)` +
          (newAliases.length ? `, ${newAliases.length} alias(es)` : "") +
          (rawProfile ? ", bio" : "") +
          (realname ? ", realname" : "") +
          (collabPartnerIds.size ? `, ${collabPartnerIds.size} collab(s)` : "")
      );
    } else {
      stats.failed++;
      console.log(`⚠ ${name}: synced with write error(s) — left unprocessed for retry`);
    }
  }

  console.log(
    `\nDone. ${stats.staged} link(s) staged, ${stats.aliases} alias(es), ${stats.bios} bio(s), ` +
      `${stats.realnames} realname(s), ${stats.collabs} collab edge(s); ` +
      `${stats.noUrls} artist(s) with no usable URLs, ${stats.resolvedOld} old-format URL(s) resolved, ` +
      `${stats.skippedNonArtist} wrong-field URL(s), ${stats.failed} failure(s).`
  );
  if (Object.keys(stagedByPlatform).length > 0) {
    console.log("New staged links by platform:");
    for (const [platform, count] of Object.entries(stagedByPlatform).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${platform}: ${count}`);
    }
  }
  if (stats.staged > 0) {
    console.log("\nNext: node scripts/integrate-harvested-links.mjs (2d) to promote staged links.");
  }
}

// Return the subset of `names` not already present (case-insensitively)
// as an alias for this artist, and not equal to the artist's own name.
async function pickNewAliases(artistId, artistName, names) {
  const cleaned = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  if (cleaned.length === 0) return [];
  const { data, error } = await supabase.from("artist_aliases").select("name").eq("artist_id", artistId);
  if (error) {
    console.error(`  (couldn't read existing aliases: ${error.message})`);
    return [];
  }
  const existing = new Set((data ?? []).map((r) => norm(r.name)));
  existing.add(norm(artistName));
  const out = [];
  const seen = new Set();
  for (const n of cleaned) {
    const key = norm(n);
    if (existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

// Upsert an undirected collaboration edge (artist_id_a < artist_id_b per
// the table CHECK), source_platform='discogs'. Increments collab_count
// on conflict. Returns true on success. Mirrors enrich-musicbrainz.mjs.
async function upsertCollab(idA, idB) {
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
  const { error: insertErr } = await supabase
    .from("collaborations")
    .insert({ artist_id_a: lo, artist_id_b: hi, collab_count: 1, source_platform: "discogs" });
  if (!insertErr) return true;

  if (insertErr.code === "23505") {
    const { data: existing, error: selErr } = await supabase
      .from("collaborations")
      .select("id, collab_count")
      .eq("artist_id_a", lo)
      .eq("artist_id_b", hi)
      .eq("source_platform", "discogs")
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
  console.error("\nSync failed:", err?.message ?? err);
  process.exit(1);
});
