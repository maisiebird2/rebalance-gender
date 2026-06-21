#!/usr/bin/env node
// ============================================================
// SoundCloud link + bio harvesting (staging only — does NOT touch
// artist_links, artist_enrichment, or the live app).
//
// For every artist with a SoundCloud profile link, fetches their
// public SoundCloud page and pulls out two things:
//
//   1. Links to other platforms (Instagram, Spotify, YouTube,
//      Resident Advisor, Bandcamp, Facebook, TikTok, Linktree,
//      Beatport, Discogs, personal websites, ...), from:
//        a. The structured "Links" section (SoundCloud calls these
//           "web profiles"), embedded in the page's hydration JSON
//           (window.__sc_hydration = [...]).
//        b. The bio/description text itself, which may contain
//           plain URLs or SoundCloud's gate.sc click-tracking
//           redirects, e.g.
//             https://gate.sc/?url=https%3A%2F%2Fwww.instagram.com%2Fdanz_cm%2F%3Fhl%3Den&token=...
//           which decodes to:
//             https://www.instagram.com/danz_cm/?hl=en
//      Twitter/X links are always skipped. Instagram URLs have
//      their query string stripped (?hl=en etc.) before saving.
//
//   2. The full, raw bio text itself — the untruncated description
//      from the hydration data, falling back to the truncated
//      og:description/twitter:description meta tag if hydration
//      parsing fails. This is saved as-is, with no further parsing
//      (no booking/management/contact/Linktree splitting) — that's
//      deliberately left for a later step.
//
// Both are written to dedicated staging tables —
// artist_harvested_links and artist_harvested_bios — NOT to
// artist_links or artist_enrichment. Both tables intentionally have
// no RLS policy for anon/authenticated, so they're invisible to the
// public site and the admin UI. A separate, later process will
// review and decide how to incorporate this data into the live
// tables.
//
// No API keys required.
//
// Usage (from the wem-directory/ folder):
//
//   node scripts/harvest-soundcloud-links-and-bio.mjs                  # all artists with a SoundCloud link
//   node scripts/harvest-soundcloud-links-and-bio.mjs --limit=20       # only the first 20 (for testing)
//   node scripts/harvest-soundcloud-links-and-bio.mjs --force          # re-fetch even pages already harvested (bypasses fetch cache)
//   node scripts/harvest-soundcloud-links-and-bio.mjs --debug          # log raw webProfiles + every candidate link found per artist
//   DRY_RUN=1 node scripts/harvest-soundcloud-links-and-bio.mjs        # fetch + log, don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
//
// One HTTP request per artist with a SoundCloud link, with a short
// delay between requests to be polite. For ~1450 artists a full run
// can take a while — start with --limit to sanity-check results
// before running on everything.
//
// Fetch results are cached in harvest-soundcloud-links-and-bio-cache.json
// alongside this script (which SoundCloud URLs have already been
// fetched + how many links were found) so re-running without
// --force skips work that's already done.
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
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

// ------------------------------------------------------------
// Fetch-level cache — persisted to disk between runs.
// Structure: { [soundcloudUrl]: { checkedAt: ISO string, linkCount: number, hasBio: boolean } }
// A URL present in the cache is not re-fetched unless --force is passed.
// (The actual harvested data lives in the DB, not the cache — this
// cache only remembers "have I already scraped this page".)
// ------------------------------------------------------------
const CACHE_PATH = path.join(__dirname, "harvest-soundcloud-links-and-bio-cache.json");

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
// HTML entity decoding (same minimal set used elsewhere in this
// project's scrapers — full entity decoding isn't needed here).
// ------------------------------------------------------------
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ------------------------------------------------------------
// Hydration JSON — the data React hydrates SoundCloud's page with.
// Holds the full (untruncated) bio under the "user" entry's
// `description`, and the structured "Links" section under a
// "webProfiles"-ish entry.
// ------------------------------------------------------------
const HYDRATION_REGEX = /window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);/;

function parseHydration(html) {
  const match = html.match(HYDRATION_REGEX);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function getUserDescription(hydration) {
  const userEntry = Array.isArray(hydration)
    ? hydration.find((h) => h?.hydratable === "user" && h?.data?.description)
    : null;
  return userEntry?.data?.description ?? null;
}

function extractWebProfilesRaw(hydration) {
  if (!Array.isArray(hydration)) return [];

  const entry = hydration.find(
    (h) => typeof h?.hydratable === "string" && /web.?profiles?/i.test(h.hydratable)
  );

  const data = entry?.data;
  if (!Array.isArray(data)) return [];

  return data
    .map((p) => ({
      network: (p?.service ?? p?.network ?? p?.platform ?? "").toString(),
      url: typeof p?.url === "string" ? p.url.trim() : null,
      handle: p?.username ?? p?.title ?? null,
    }))
    .filter((p) => p.url);
}

// ------------------------------------------------------------
// gate.sc is SoundCloud's link-click tracker — it wraps outbound
// URLs in bio text, e.g.:
//   https://gate.sc/?url=https%3A%2F%2Fwww.instagram.com%2Fdanz_cm%2F&token=...
//   https://gate.sc?url=https%3A%2F%2Flinktr.ee%2Famelie.lens&token=...
// (both with and without the slash before "?" show up). Decode
// every occurrence in `text`, returning the list of decoded target
// URLs found (the wrapper itself is discarded).
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
// Plain (unwrapped) URLs to known platforms mentioned directly in
// bio text, e.g. "more music: https://open.spotify.com/artist/..."
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

// Universal share-widget / boilerplate links that show up on every
// SoundCloud page regardless of artist — never real profile links.
const SHARE_WIDGET_REGEX = /\/(sharer|share\.php|intent\/tweet|dialog\/share)\b/i;
const SOUNDCLOUD_OWN_ACCOUNT_REGEX = /\/(soundcloud|sc-discover)\/?($|[?#])/i;

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
  if (SHARE_WIDGET_REGEX.test(url.pathname)) return null;
  if (SOUNDCLOUD_OWN_ACCOUNT_REGEX.test(url.pathname)) return null;

  for (const [hostRegex, platform] of DOMAIN_PLATFORM_MAP) {
    if (hostRegex.test(host)) return platform;
  }

  // Unrecognized external domain — still worth keeping as a generic
  // "website" candidate (e.g. a personal site), per the broader
  // platform-coverage decision for this harvest.
  return "website";
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
  return url.toString();
}

// ------------------------------------------------------------
// Fetch a SoundCloud profile page and return:
//   - candidates: every (rawUrl, platform, parsedUrl) triple found
//     in its webProfiles data and bio text
//   - rawBio: the full, unparsed bio text (hydration description,
//     falling back to the og:description/twitter:description meta
//     tag), or null if neither is present
// ------------------------------------------------------------
async function harvestFromSoundCloud(scUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(scUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; WEMDirectoryBot/1.0; +link and bio harvesting)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    if (!res.ok) return { ok: false, candidates: [], rawBio: null };

    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      while (html.length < 2_000_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (HYDRATION_REGEX.test(html)) break;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }

    const hydration = parseHydration(html);
    const webProfiles = extractWebProfilesRaw(hydration);

    if (DEBUG) {
      console.log("  [debug] webProfiles raw:", JSON.stringify(webProfiles));
    }

    // ---- Raw bio (untruncated where possible, otherwise the
    // truncated meta-tag preview) — saved as-is, no parsing. ----
    let description = getUserDescription(hydration);
    if (!description) {
      const metaRegex =
        /<meta[^>]+(?:property|name)=["'](?:og:description|twitter:description)["'][^>]+content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](?:og:description|twitter:description)["'][^>]*>/i;
      const match = html.match(metaRegex);
      description = match?.[1] ?? match?.[2] ?? null;
    }
    const rawBio = description ? decodeEntities(description).trim() || null : null;

    // ---- Other-platform links, from webProfiles + bio text ----
    const decodedBio = description ? decodeEntities(description) : "";

    const candidatesRaw = [];

    for (const p of webProfiles) {
      candidatesRaw.push({ rawUrl: p.url, source: "webProfiles" });
    }

    for (const target of extractGateScTargets(decodedBio)) {
      candidatesRaw.push({ rawUrl: target, source: "bio:gate.sc" });
    }

    // Plain URLs in the bio, skipping ones already caught via gate.sc
    // decoding (gate.sc wrapper text itself would otherwise also
    // match the plain-URL regex).
    for (const plain of extractPlainUrls(decodedBio)) {
      if (/gate\.sc/i.test(plain)) continue;
      candidatesRaw.push({ rawUrl: plain, source: "bio:plain" });
    }

    if (DEBUG) {
      console.log("  [debug] all candidates:", JSON.stringify(candidatesRaw));
    }

    // Classify + normalize, dropping anything unclassifiable
    // (null = twitter/x, self-link, or a share widget).
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
  } catch (err) {
    if (DEBUG) console.log(`  [debug] fetch failed: ${err?.message ?? err}`);
    return { ok: false, candidates: [], rawBio: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running SoundCloud link + bio harvest\n");

  const cache = FORCE ? {} : loadCache();
  if (FORCE) {
    console.log("--force: bypassing fetch cache\n");
  } else {
    const cachedCount = Object.keys(cache).length;
    if (cachedCount > 0) {
      console.log(`Fetch cache loaded: ${cachedCount} SoundCloud URL(s) already scraped (pass --force to bypass)\n`);
    }
  }

  // Pull every SoundCloud link directly off artist_links (an artist
  // could in principle have more than one SoundCloud account).
  let query = supabase
    .from("artist_links")
    .select("artist_id, url, artists!inner(name)")
    .eq("platform", "soundcloud");

  if (NAME_FILTER) {
    query = query.ilike("artists.name", `%${NAME_FILTER}%`);
  }

  const { data: links, error } = await query;
  if (error) throw error;

  let rows = links;
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(`Found ${links.length} SoundCloud link(s) on artists${LIMIT ? `, processing first ${rows.length}` : ""}\n`);

  let scraped = 0;
  let skippedCached = 0;
  let fetchFailed = 0;
  let totalLinksFound = 0;
  let totalLinksWritten = 0;
  let biosFound = 0;
  let biosWritten = 0;
  const byPlatform = {};

  for (const row of rows) {
    const name = row.artists?.name ?? row.artist_id;
    const scUrl = row.url;

    if (!FORCE && cache[scUrl] !== undefined) {
      skippedCached++;
      continue;
    }

    scraped++;
    const { ok, candidates, rawBio } = await harvestFromSoundCloud(scUrl);

    if (!ok) {
      fetchFailed++;
      console.log(`✗ ${name}: failed to fetch ${scUrl}`);
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
          } else {
            biosWritten++;
          }
        }
      } else {
        totalLinksWritten += candidates.length;
        if (rawBio) biosWritten++;
      }

      for (const c of candidates) {
        byPlatform[c.platform] = (byPlatform[c.platform] ?? 0) + 1;
      }
    }

    cache[scUrl] = {
      checkedAt: new Date().toISOString(),
      linkCount: candidates.length,
      hasBio: Boolean(rawBio),
    };
    if (!DRY_RUN) saveCache(cache);

    await sleep(300);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  scraped:                ${scraped}`);
  console.log(`  skipped (cached):       ${skippedCached}`);
  console.log(`  fetch failed:           ${fetchFailed}`);
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
