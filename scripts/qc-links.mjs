#!/usr/bin/env node
// ============================================================
// Data QC: artist_links URL validation
//
// Two categories of checks:
//
//   1. WRONG FIELD — a URL is stored under the wrong platform key.
//      E.g. a musicbrainz.org URL saved in the lastfm field, or a
//      soundcloud.com URL saved in the discogs field. Detected by
//      comparing each URL's actual domain against the expected
//      domain(s) for its platform, then cross-referencing against
//      every OTHER platform's known domains to identify where it
//      should have gone.
//
//   2. FORMAT ISSUES — the URL value itself is malformed:
//      • Contains whitespace (leading/trailing or internal spaces,
//        tabs, or newlines)
//      • Contains multiple URLs (two or more "http" occurrences)
//      • Doesn't parse as a valid URL (new URL() throws)
//      • Uses plain http:// rather than https://
//      • Missing protocol entirely (not starting with http)
//
// This script is read-only — it reports issues but makes no changes.
// Fix any problems it finds via the admin edit page for each artist.
//
// Usage (from rebalance-gender/):
//
//   node scripts/qc-links.mjs                        # check all rows
//   node scripts/qc-links.mjs --platform=lastfm      # one platform only
//   node scripts/qc-links.mjs --name="Danz"          # artists matching name
//   node scripts/qc-links.mjs --limit=100            # first N artists
//   node scripts/qc-links.mjs --debug                # show every row checked
//   node scripts/qc-links.mjs --csv                  # output issues as CSV
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const CSV_MODE = args.includes("--csv");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;
const platformArg = args.find((a) => a.startsWith("--platform="));
const PLATFORM_FILTER = platformArg ? platformArg.slice("--platform=".length) : null;

// ── Load .env.local ─────────────────────────────────────────
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

const supabase = createClient(SUPABASE_URL, SECRET_KEY);

// ── Platform domain definitions ─────────────────────────────
// For each platform key, the canonical hostname(s) a URL in that
// field should have. Used for two purposes:
//   (a) checking whether a stored URL actually matches its platform
//   (b) detecting which platform a URL *should* be in
//
// Bandcamp is a special case: artist pages live at subdomains
// (artist.bandcamp.com), not paths on bandcamp.com itself. The
// check function handles this separately.
//
// "homepage" and "other" are intentionally omitted — any domain
// is valid for those, so there's nothing to cross-check.

const PLATFORM_DOMAINS = {
  soundcloud:       ["soundcloud.com"],
  instagram:        ["instagram.com", "www.instagram.com"],
  resident_advisor: ["ra.co", "www.ra.co"],
  bandcamp:         ["bandcamp.com"],        // see isBandcampUrl()
  beatport:         ["beatport.com", "www.beatport.com"],
  qobuz:            ["qobuz.com", "www.qobuz.com"],
  discogs:          ["discogs.com", "www.discogs.com"],
  linktree:         ["linktr.ee", "www.linktr.ee", "linktree.com", "www.linktree.com"],
  apple_music:      ["music.apple.com"],
  spotify:          ["open.spotify.com", "spotify.com"],
  musicbrainz:      ["musicbrainz.org", "www.musicbrainz.org"],
  lastfm:           ["last.fm", "www.last.fm"],
  wikipedia:        ["en.wikipedia.org", "wikipedia.org", "www.wikipedia.org"],
};

// Platforms where any URL is considered valid (no domain constraint).
const UNCHECKED_PLATFORMS = new Set(["homepage", "other"]);

/** Returns the hostname (lowercase, without trailing dot) from a URL string. */
function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** True if the hostname is a Bandcamp artist subdomain or bandcamp.com itself. */
function isBandcampUrl(hostname) {
  if (!hostname) return false;
  return hostname === "bandcamp.com" || hostname.endsWith(".bandcamp.com");
}

/**
 * Returns true if `url` is a valid URL for the given `platform`.
 * For unchecked platforms (homepage, other) always returns true.
 */
function urlMatchesPlatform(platform, url) {
  if (UNCHECKED_PLATFORMS.has(platform)) return true;
  const hostname = getHostname(url);
  if (!hostname) return false;

  if (platform === "bandcamp") return isBandcampUrl(hostname);

  const expected = PLATFORM_DOMAINS[platform];
  if (!expected) return true; // unknown platform — skip domain check
  return expected.includes(hostname);
}

/**
 * Given a URL, returns the platform key it *looks like* it belongs to,
 * or null if it doesn't match any known platform.
 */
function detectPlatformFromUrl(url) {
  const hostname = getHostname(url);
  if (!hostname) return null;

  if (isBandcampUrl(hostname) && hostname !== "bandcamp.com") {
    // Proper artist subdomain — it's bandcamp
    return "bandcamp";
  }

  for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
    if (domains.includes(hostname)) return platform;
  }
  return null;
}

// ── Format checks ────────────────────────────────────────────

/**
 * Returns an array of format issue strings for a URL.
 * Empty array means no issues.
 */
function formatIssues(url) {
  const issues = [];

  // Leading or trailing whitespace (trim already done in app, but check DB directly)
  if (url !== url.trim()) {
    issues.push("has leading/trailing whitespace");
  }

  // Internal whitespace (spaces, tabs, newlines inside the URL)
  if (/[\s]/.test(url.trim())) {
    issues.push("contains internal whitespace");
  }

  // Multiple URLs crammed into one field
  const httpCount = (url.match(/https?:\/\//g) ?? []).length;
  if (httpCount > 1) {
    issues.push(`contains ${httpCount} URLs (should be exactly 1)`);
  }

  // Not a parseable URL at all
  let parsed = null;
  try {
    parsed = new URL(url.trim());
  } catch {
    issues.push("not a valid URL (fails URL parsing)");
    return issues; // remaining checks need a parsed URL
  }

  // Non-https protocol
  if (parsed.protocol === "http:") {
    issues.push("uses http:// instead of https://");
  } else if (parsed.protocol !== "https:") {
    issues.push(`unexpected protocol: ${parsed.protocol}`);
  }

  return issues;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.error("Fetching artist_links…");

  // Fetch all non-not_found links, joined to artist name.
  let query = supabase
    .from("artist_links")
    .select("id, platform, url, artists(id, name)")
    .eq("not_found", false)
    .not("url", "is", null)
    .order("platform")
    .order("id");

  if (PLATFORM_FILTER) {
    query = query.eq("platform", PLATFORM_FILTER);
  }

  if (NAME_FILTER) {
    // Filter via the joined artists table
    query = query.ilike("artists.name", `%${NAME_FILTER}%`);
  }

  const { data: rows, error } = await query;
  if (error) {
    console.error("Supabase error:", error.message);
    process.exit(1);
  }

  // Filter out rows where the artist name join returned null
  // (this can happen with name filter since it's a PostgREST inner-join)
  let links = (rows ?? []).filter((r) => r.artists?.name);

  if (NAME_FILTER) {
    links = links.filter((r) =>
      r.artists.name.toLowerCase().includes(NAME_FILTER.toLowerCase())
    );
  }

  if (LIMIT) {
    // Limit applies per artist, not per row — find first N unique artist IDs.
    const seen = new Set();
    const limited = [];
    for (const r of links) {
      seen.add(r.artists.id);
      if (seen.size > LIMIT) break;
      limited.push(r);
    }
    links = limited;
  }

  console.error(`Checking ${links.length} links…\n`);

  // ── Collect issues ─────────────────────────────────────────
  const wrongField = [];   // { id, artistId, artistName, platform, url, detectedPlatform }
  const badFormat  = [];   // { id, artistId, artistName, platform, url, issues[] }

  for (const row of links) {
    const { id, platform, url } = row;
    const artistId = row.artists.id;
    const artistName = row.artists.name;

    if (DEBUG) {
      console.error(`  [${platform}] ${artistName}: ${url}`);
    }

    // ── Format check ────────────────────────────────────────
    const fIssues = formatIssues(url);
    if (fIssues.length > 0) {
      badFormat.push({ id, artistId, artistName, platform, url, issues: fIssues });
    }

    // ── Wrong-field check ────────────────────────────────────
    // Skip unchecked platforms, unknown platforms, and rows where
    // the URL can't be parsed at all (those are already captured as
    // format issues; we can't derive a hostname to compare against).
    const urlIsParseable = getHostname(url) !== null;
    if (!UNCHECKED_PLATFORMS.has(platform) && PLATFORM_DOMAINS[platform] && urlIsParseable) {
      if (!urlMatchesPlatform(platform, url)) {
        const detectedPlatform = detectPlatformFromUrl(url);
        wrongField.push({ id, artistId, artistName, platform, url, detectedPlatform });
      }
    }
  }

  // ── Output ──────────────────────────────────────────────────
  const totalIssues = wrongField.length + badFormat.length;

  if (CSV_MODE) {
    outputCsv(wrongField, badFormat);
  } else {
    outputReport(wrongField, badFormat, links.length, totalIssues);
  }

  process.exit(totalIssues > 0 ? 1 : 0);
}

// ── Reporters ────────────────────────────────────────────────

function outputReport(wrongField, badFormat, total, totalIssues) {
  console.log("=".repeat(60));
  console.log("ARTIST LINKS QC REPORT");
  console.log("=".repeat(60));
  console.log(`Rows checked : ${total}`);
  console.log(`Issues found : ${totalIssues}`);
  console.log();

  // ── Wrong-field issues ────────────────────────────────────
  console.log(`── WRONG FIELD (${wrongField.length}) ${"─".repeat(40 - wrongField.length.toString().length)}`);
  if (wrongField.length === 0) {
    console.log("  None ✓");
  } else {
    // Group by platform for easier scanning
    const byPlatform = {};
    for (const issue of wrongField) {
      (byPlatform[issue.platform] ??= []).push(issue);
    }
    for (const [platform, issues] of Object.entries(byPlatform)) {
      console.log(`\n  Platform: ${platform} (${issues.length} issue${issues.length !== 1 ? "s" : ""})`);
      for (const issue of issues) {
        const detected = issue.detectedPlatform
          ? `→ looks like: ${issue.detectedPlatform}`
          : "→ no matching platform detected";
        console.log(`    Artist : ${issue.artistName}`);
        console.log(`    Link ID: ${issue.id}`);
        console.log(`    URL    : ${issue.url}`);
        console.log(`    ${detected}`);
        console.log(`    Fix at : /artist/${issue.artistId}/edit`);
        console.log();
      }
    }
  }

  console.log();

  // ── Format issues ─────────────────────────────────────────
  console.log(`── FORMAT ISSUES (${badFormat.length}) ${"─".repeat(40 - badFormat.length.toString().length)}`);
  if (badFormat.length === 0) {
    console.log("  None ✓");
  } else {
    // Group by issue type for easier scanning
    const byIssue = {};
    for (const item of badFormat) {
      for (const issue of item.issues) {
        (byIssue[issue] ??= []).push(item);
      }
    }
    for (const [issue, items] of Object.entries(byIssue)) {
      console.log(`\n  Issue: "${issue}" (${items.length} row${items.length !== 1 ? "s" : ""})`);
      for (const item of items) {
        console.log(`    Artist   : ${item.artistName}`);
        console.log(`    Platform : ${item.platform}`);
        console.log(`    Link ID  : ${item.id}`);
        console.log(`    URL      : ${JSON.stringify(item.url)}`);  // JSON so whitespace is visible
        console.log(`    Fix at   : /artist/${item.artistId}/edit`);
        console.log();
      }
    }
  }

  console.log("=".repeat(60));
  if (totalIssues === 0) {
    console.log("All links look good!");
  } else {
    console.log(`${totalIssues} issue${totalIssues !== 1 ? "s" : ""} to review.`);
  }
  console.log("=".repeat(60));
}

function outputCsv(wrongField, badFormat) {
  // CSV output: one row per issue
  const cols = ["issue_type", "link_id", "artist_name", "artist_id", "platform", "url", "detail"];
  console.log(cols.join(","));

  function csvRow(values) {
    return values
      .map((v) => {
        const s = String(v ?? "");
        // Quote if contains comma, quote, or newline
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      })
      .join(",");
  }

  for (const issue of wrongField) {
    const detail = issue.detectedPlatform
      ? `should be: ${issue.detectedPlatform}`
      : "domain not recognised";
    console.log(csvRow([
      "wrong_field",
      issue.id,
      issue.artistName,
      issue.artistId,
      issue.platform,
      issue.url,
      detail,
    ]));
  }

  for (const item of badFormat) {
    for (const issueText of item.issues) {
      console.log(csvRow([
        "format",
        item.id,
        item.artistName,
        item.artistId,
        item.platform,
        item.url,
        issueText,
      ]));
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
