#!/usr/bin/env node
// ============================================================
// Promotes rows from the artist_harvested_links staging table
// (populated by harvest-soundcloud-links-and-bio.mjs) into the live
// artist_links table.
//
// Rule, per (artist, platform):
//
//   - First, an artist can have more than one harvested candidate
//     for the same platform (e.g. two Instagram links listed on
//     their SoundCloud page). Only the FIRST one is kept — "first"
//     meaning earliest discovered_at, tie-broken by lowest id, which
//     in practice means whichever was listed first on the page and
//     harvested first in the process. Every other candidate for that
//     (artist, platform) pair is excluded from integration entirely:
//     it's not inserted, not compared against anything, and not
//     flagged. Having a second listed link for the same platform
//     isn't treated as a discrepancy.
//
//   - If the artist has NO artist_links row for that platform yet,
//     that one surviving candidate is inserted into artist_links.
//     That becomes the "canonical" URL for the pair from then on.
//
//   - If the artist ALREADY has an artist_links row for that
//     platform, that existing URL is the canonical one. Nothing is
//     overwritten — this script never edits or removes a row that's
//     already in artist_links.
//
// That one surviving harvested row per (artist, platform) pair is
// then compared against whichever URL is canonical:
//
//   - If it matches, artist_harvested_links.artist_links_url is
//     cleared (set to null) — "checked, no conflict".
//   - If it doesn't match, artist_harvested_links.artist_links_url
//     is set to the canonical URL, so the row visibly flags "the
//     live site has a different URL for this artist+platform than
//     what I found" for a human to review later.
//   - Excluded (non-first) candidates also have their
//     artist_links_url cleared to null, in case an earlier run of
//     this script (before this filtering existed) had flagged them.
//
// Harvested rows whose parsed_platform doesn't correspond to a key
// in the platforms table are skipped entirely (left untouched) —
// e.g. at the time this script was written, "youtube", "facebook",
// "tiktok", and "website" had not yet been added as platform keys
// (see supabase_schema.sql's platforms seed list). Add them via the
// admin panel's platform management, or directly in `platforms`,
// then re-run.
//
// Before any of the above, link shorteners (currently just bit.ly)
// are resolved to their real target. This is done with a HEAD
// request and redirect:"manual" — we only ever read the redirect
// response's `Location` header, never the destination page's body —
// so it's fast and stays fast even across many rows. The resolved
// URL replaces parsed_url and is reclassified by domain (same
// platform list as harvest-soundcloud-links-and-bio.mjs), both
// in-memory for this run's decisions and persisted back to
// artist_harvested_links so future runs don't need to re-resolve it.
// This is the one place this script makes outbound HTTP calls;
// everything else is pure DB-to-DB.
//
// Usage (from the wem-directory/ folder):
//
//   node scripts/integrate-harvested-links.mjs                  # process every (artist, platform) pair
//   node scripts/integrate-harvested-links.mjs --limit=20       # only the first 20 pairs (for testing)
//   node scripts/integrate-harvested-links.mjs --name="Danz"    # only artists whose name contains this (case-insensitive)
//   node scripts/integrate-harvested-links.mjs --debug          # log every group's decision
//   DRY_RUN=1 node scripts/integrate-harvested-links.mjs        # log what would happen, don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// Safe to re-run — re-running settles artist_links_url back to
// whatever is currently true, and never re-inserts a pair that
// already has an artist_links row.
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
const DEBUG = args.includes("--debug");
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

// ------------------------------------------------------------
// Supabase/PostgREST caps unpaginated queries at 1000 rows. Fetch
// in pages until a page comes back short.
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

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

// ------------------------------------------------------------
// Compares a harvested URL against the canonical (already-live, or
// about-to-be-inserted) URL for a (artist, platform) pair, ignoring
// formatting differences that don't actually change where the link
// points:
//   - http vs https ("http://x.com/a" vs "https://x.com/a")
//   - a trailing slash on either side ("https://x.com/a" vs
//     "https://x.com/a/")
//   - a "www." prefix on either side ("https://instagram.com/a" vs
//     "https://www.instagram.com/a")
//   - hostname case ("Instagram.com" vs "instagram.com")
// Falls back to a plain string comparison if either value isn't a
// parseable URL.
// ------------------------------------------------------------
function normalizeForComparison(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function urlsMatch(a, b) {
  if (a === b) return true;
  return normalizeForComparison(a) === normalizeForComparison(b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Link shortener resolution (currently just bit.ly).
//
// A HEAD request with redirect:"manual" gets back the redirect
// response itself (status 3xx + a `Location` header) instead of
// fetch silently following it — so we never download the
// destination page's body, just the one header we need. Chained
// redirects (a short link pointing at another short link) are
// followed up to MAX_REDIRECT_HOPS times.
// ------------------------------------------------------------
const SHORTENER_HOSTS = new Set(["bit.ly"]);
const MAX_REDIRECT_HOPS = 5;
const resolveCache = new Map(); // shortUrl -> resolvedUrl | null

function isShortenerUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return SHORTENER_HOSTS.has(host);
  } catch {
    return false;
  }
}

async function followOneRedirect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WEMDirectoryBot/1.0; +link resolving)",
      },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      return new URL(location, url).toString();
    }
    return null; // not a redirect — this is the final destination
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveShortLink(rawUrl) {
  if (resolveCache.has(rawUrl)) return resolveCache.get(rawUrl);

  let current = rawUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const next = await followOneRedirect(current);
    if (!next || next === current) break;
    current = next;
  }

  const resolved = current === rawUrl ? null : current;
  resolveCache.set(rawUrl, resolved);
  return resolved;
}

// ------------------------------------------------------------
// Reclassifies a resolved URL by domain. Mirrors the platform map
// in harvest-soundcloud-links-and-bio.mjs (kept as a separate copy,
// same as every other per-script convention in this folder, rather
// than a shared import).
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

function classifyResolved(rawUrl) {
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
  return "other";
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Integrating harvested links into artist_links\n");

  const [harvested, existingLinks, platforms] = await Promise.all([
    fetchAll(
      "artist_harvested_links",
      NAME_FILTER
        ? "id, artist_id, source_platform, source_url, raw_url, parsed_platform, parsed_url, discovered_at, artist_links_url, artists!inner(name)"
        : "id, artist_id, source_platform, source_url, raw_url, parsed_platform, parsed_url, discovered_at, artist_links_url",
      (q) => (NAME_FILTER ? q.ilike("artists.name", `%${NAME_FILTER}%`) : q)
    ),
    fetchAll("artist_links", "id, artist_id, platform, url"),
    supabase.from("platforms").select("key").then(({ data, error }) => {
      if (error) throw error;
      return data;
    }),
  ]);

  const platformKeys = new Set(platforms.map((p) => p.key));
  const harvestedById = new Map(harvested.map((row) => [row.id, row]));

  // Resolve any link-shortener URLs (currently just bit.ly) to their
  // real target before anything else, so the rest of the script
  // works with the actual destination. Mutates `row` in place;
  // resolution updates are persisted later alongside the
  // mismatch-flag updates.
  const rowUpdates = new Map(); // id -> partial update object, always includes id

  function mergeUpdate(id, fields) {
    rowUpdates.set(id, { ...(rowUpdates.get(id) ?? { id }), ...fields });
  }

  const shortenerRows = harvested.filter((row) => isShortenerUrl(row.parsed_url));
  let resolvedCount = 0;
  let resolveFailedCount = 0;

  if (shortenerRows.length > 0) {
    console.log(`Resolving ${shortenerRows.length} shortened link(s)...`);
    for (const row of shortenerRows) {
      const resolved = await resolveShortLink(row.parsed_url);
      if (resolved) {
        const newPlatform = classifyResolved(resolved);
        if (DEBUG) {
          console.log(
            `  resolved ${row.parsed_url} -> ${resolved} (platform: ${newPlatform ?? "excluded"})`
          );
        }
        row.parsed_url = resolved;
        row.parsed_platform = newPlatform;
        mergeUpdate(row.id, { parsed_url: resolved, parsed_platform: newPlatform });
        resolvedCount++;
      } else {
        resolveFailedCount++;
        if (DEBUG) console.log(`  could not resolve ${row.parsed_url}`);
      }
      await sleep(150);
    }
    console.log(`Resolved ${resolvedCount}, failed to resolve ${resolveFailedCount}.\n`);
  }

  // Canonical URL already in artist_links, per (artist_id, platform).
  // If an artist somehow has more than one existing row for the same
  // platform (the DB constraint allows it), the lowest-id one wins —
  // arbitrary but deterministic.
  const existingMap = new Map();
  for (const row of existingLinks) {
    const key = `${row.artist_id}|${row.platform}`;
    if (!existingMap.has(key)) existingMap.set(key, row.url);
  }

  // Group harvested rows by (artist_id, parsed_platform).
  const groups = new Map();
  for (const row of harvested) {
    if (!row.parsed_platform) continue; // undetected platform, nothing to integrate
    const key = `${row.artist_id}|${row.parsed_platform}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let groupKeys = [...groups.keys()];
  if (LIMIT) groupKeys = groupKeys.slice(0, LIMIT);

  console.log(
    `${harvested.length} harvested row(s) across ${groups.size} (artist, platform) pair(s)` +
      `${LIMIT ? `, processing first ${groupKeys.length} pair(s)` : ""}\n`
  );

  const toInsert = [];
  const skippedNoPlatformKey = {};
  let pairsAlreadyLinked = 0;
  let pairsNewlyLinked = 0;
  let excludedExtraCandidates = 0;
  let flaggedCount = 0;
  let clearedCount = 0;

  for (const key of groupKeys) {
    const [artistId, platform] = key.split("|");
    const rows = groups.get(key);

    if (!platformKeys.has(platform)) {
      skippedNoPlatformKey[platform] = (skippedNoPlatformKey[platform] ?? 0) + rows.length;
      if (DEBUG) console.log(`~ ${key}: skipped, "${platform}" is not a known platform key`);
      continue;
    }

    // Keep only the first-listed candidate for this (artist,
    // platform) pair — earliest discovered_at, tie-broken by lowest
    // id. Any additional candidates are excluded entirely: not
    // inserted, not compared, not flagged. (Any stale flag one of
    // them was given by an earlier version of this script gets
    // cleared below.)
    const sorted = [...rows].sort((a, b) => {
      const byDate = new Date(a.discovered_at) - new Date(b.discovered_at);
      return byDate !== 0 ? byDate : a.id - b.id;
    });
    const [winner, ...excluded] = sorted;

    if (excluded.length > 0) {
      excludedExtraCandidates += excluded.length;
      if (DEBUG) {
        console.log(
          `  (ignoring ${excluded.length} additional candidate(s) for ${key}: ${excluded
            .map((r) => r.parsed_url)
            .join(", ")})`
        );
      }
      for (const row of excluded) {
        if ((row.artist_links_url ?? null) !== null) {
          mergeUpdate(row.id, { artist_links_url: null });
          clearedCount++;
        }
      }
    }

    let canonicalUrl = existingMap.get(key);

    if (canonicalUrl) {
      pairsAlreadyLinked++;
    } else {
      // No existing artist_links row for this pair — promote the
      // surviving candidate.
      canonicalUrl = winner.parsed_url;
      pairsNewlyLinked++;
      toInsert.push({ artist_id: artistId, platform, handle: null, url: canonicalUrl });
      if (DEBUG) console.log(`+ ${key}: inserting ${canonicalUrl} (from harvested row #${winner.id})`);
    }

    const matches = urlsMatch(winner.parsed_url, canonicalUrl);
    const desired = matches ? null : canonicalUrl;
    if (desired !== (winner.artist_links_url ?? null)) {
      if (matches) {
        mergeUpdate(winner.id, { artist_links_url: null });
        clearedCount++;
      } else {
        mergeUpdate(winner.id, { artist_links_url: canonicalUrl });
        flaggedCount++;
        if (DEBUG) {
          console.log(
            `  ! mismatch on harvested row #${winner.id}: harvested=${winner.parsed_url} vs live=${canonicalUrl}`
          );
        }
      }
    }
  }

  console.log(`Pairs already linked in artist_links: ${pairsAlreadyLinked}`);
  console.log(`Pairs newly inserted into artist_links: ${pairsNewlyLinked}`);
  console.log(`Additional candidates excluded (2nd+ link for same artist+platform): ${excludedExtraCandidates}`);
  console.log(`Harvested rows flagged as mismatched:  ${flaggedCount}`);
  console.log(`Harvested rows cleared (now matching or excluded): ${clearedCount}`);
  if (Object.keys(skippedNoPlatformKey).length > 0) {
    console.log(`Skipped — platform key doesn't exist yet in \`platforms\`:`);
    for (const [platform, count] of Object.entries(skippedNoPlatformKey).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${platform}: ${count} row(s)`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no changes written.");
    return;
  }

  if (toInsert.length > 0) {
    for (const batch of chunk(toInsert, 500)) {
      const { error } = await supabase
        .from("artist_links")
        .upsert(batch, { onConflict: "artist_id,platform,url", ignoreDuplicates: true });
      if (error) {
        console.error(`Failed to insert a batch of ${batch.length} new artist_links row(s): ${error.message}`);
      }
    }
  }

  // Normalize every pending update to the same full shape, backfilling
  // any field a given update didn't touch from the row's current
  // value. This matters for two reasons:
  //   1. A single upsert batch can otherwise mix rows that only set
  //      parsed_url/parsed_platform (from resolution) with rows that
  //      only set artist_links_url (from flagging) — PostgREST builds
  //      one column list per batch, so an object missing a key it
  //      never meant to touch could get that column wiped to null
  //      instead of left alone.
  //   2. upsert(..., { onConflict: "id" }) is a real INSERT ... ON
  //      CONFLICT DO UPDATE under the hood, and Postgres validates
  //      NOT NULL constraints on the candidate row before it even
  //      checks for a conflict — so artist_id/source_url/raw_url
  //      (NOT NULL, no default) must be present on every row or the
  //      whole batch fails with "null value in column ... violates
  //      not-null constraint", even though we only intend to update
  //      other columns.
  const updates = [...rowUpdates.values()].map((u) => {
    const original = harvestedById.get(u.id);
    return {
      id: u.id,
      artist_id: original.artist_id,
      source_platform: original.source_platform,
      source_url: original.source_url,
      raw_url: original.raw_url,
      parsed_url: "parsed_url" in u ? u.parsed_url : original.parsed_url,
      parsed_platform: "parsed_platform" in u ? u.parsed_platform : original.parsed_platform,
      artist_links_url: "artist_links_url" in u ? u.artist_links_url : (original.artist_links_url ?? null),
    };
  });
  for (const batch of chunk(updates, 500)) {
    const { error } = await supabase
      .from("artist_harvested_links")
      .upsert(batch, { onConflict: "id" });
    if (error) {
      console.error(`Failed to update a batch of ${batch.length} artist_harvested_links row(s): ${error.message}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nIntegration failed:", err?.message ?? err);
  process.exit(1);
});
