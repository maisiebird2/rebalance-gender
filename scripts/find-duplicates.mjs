#!/usr/bin/env node
// ============================================================
// Duplicate candidate detection for the Rebalance Gender directory.
//
// Signals used (in roughly descending strength):
//
//   1. Exact URL match (same platform, same normalized URL)
//      → score 1.0. Two artists sharing a SoundCloud profile URL
//        are certainly the same person. Flagged as `url_exact`.
//        (Trivially detectable via SQL, but included for completeness.)
//
//   2. Cross-platform handle similarity
//      A handle (SoundCloud slug, Instagram username, RA slug, etc.)
//      is extracted from every profile URL and normalized (lowercase,
//      punctuation stripped). If artist A's normalized SoundCloud handle
//      matches artist B's normalized Instagram handle, that's a strong
//      signal — they chose the same username on independently run
//      platforms. Scored with Jaro-Winkler on normalized handles:
//        exact match across different platforms → 0.90
//        fuzzy match ≥ 0.88                    → scaled
//      Handle matches WITHIN the same platform for a URL that already
//      differs are not flagged here — a non-matching SoundCloud handle
//      pair isn't informative; it just means different people.
//
//   3. Shared booking / contact email
//      If two artists have the same email address in booking_info,
//      management_info, or contact_info, they may be the same person
//      (or share the same exclusive manager, which is also worth a
//      look). Scored at 0.80. Emails that appear in many (≥ 4) artists
//      are likely a shared management company and are suppressed.
//
//   4. Name similarity
//      Jaro-Winkler on normalized names (lowercased, diacritics
//      stripped, punctuation removed). Only pairs scoring ≥ 0.82 are
//      generated. Blocking by name prefix and word tokens keeps this
//      from being O(n²) for the full dataset.
//
//   5. Genre overlap (supporting signal)
//      Jaccard similarity of genre sets. Small additive boost (+0.04
//      max) when there's already another signal.
//
//   6. Country overlap (supporting signal)
//      Same country in artist_locations. Small additive boost (+0.03).
//
// The "signals" CSV column lists what fired for each pair so you can
// judge at a glance without looking up both artists:
//   url_exact:soundcloud, handle_cross:dj_anna(sc↔ig), same_email, name_fuzzy:0.924
//
// Makes no database writes. Safe to run at any time.
//
// Usage (from rebalance-gender/):
//
//   node scripts/find-duplicates.mjs
//   node scripts/find-duplicates.mjs --min-score=0.75   # default 0.6
//   node scripts/find-duplicates.mjs --output=out.csv
//   node scripts/find-duplicates.mjs --no-url-exact     # skip the trivial URL matches
//   node scripts/find-duplicates.mjs --debug
//
// Output CSV columns:
//   artist_id_a, name_a, status_a,
//   artist_id_b, name_b, status_b,
//   score, confidence, signals
//
// Confidence:   very likely ≥ 0.90 | possible ≥ 0.75 | low < 0.75
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG        = args.includes("--debug");
const NO_URL_EXACT = args.includes("--no-url-exact");

const minScoreArg = args.find((a) => a.startsWith("--min-score="));
const MIN_SCORE   = minScoreArg ? parseFloat(minScoreArg.split("=")[1]) : 0.6;

const outputArg    = args.find((a) => a.startsWith("--output="));
const timestamp    = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
const rawOut       = outputArg ? outputArg.split("=")[1] : `duplicate-candidates-${timestamp}.csv`;
const OUTPUT_PATH  = path.isAbsolute(rawOut) ? rawOut : path.resolve(process.cwd(), rawOut);

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
const SECRET_KEY   = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SECRET_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// ------------------------------------------------------------
// Supabase pagination
// ------------------------------------------------------------
const PAGE_SIZE = 1000;

async function fetchAll(queryFn) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryFn(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

// ------------------------------------------------------------
// String helpers
// ------------------------------------------------------------

// Normalize an artist name for comparison: lowercase, strip diacritics,
// replace punctuation with spaces, collapse whitespace.
function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalize a platform handle for cross-platform comparison:
// lowercase, strip diacritics, keep only alphanumeric.
// Returns null if the result is too short to be meaningful (< 3 chars).
function normalizeHandle(handle) {
  if (!handle) return null;
  const norm = handle
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
  return norm.length >= 3 ? norm : null;
}

// Extract a candidate handle from a profile URL (last non-empty path segment).
function extractHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

// Normalize a URL for exact-match comparison (lowercase, strip query/hash/trailing slash).
function normalizeUrl(url) {
  try {
    const u = new URL(url.toLowerCase());
    const host = u.hostname.replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "");
    return host + pathname;
  } catch {
    return url.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

// Extract all email addresses found in a block of free text.
const EMAIL_RE = /[\w.+%-]{1,64}@[\w.-]{1,253}\.[a-z]{2,}/gi;
function extractEmails(text) {
  if (!text) return [];
  return [...text.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
}

// ------------------------------------------------------------
// Jaro-Winkler string similarity (0 = no match, 1 = identical).
// ------------------------------------------------------------
function jaro(s1, s2) {
  if (s1 === s2) return 1.0;
  const l1 = s1.length, l2 = s2.length;
  if (!l1 || !l2) return 0.0;

  const matchDist = Math.max(Math.floor(Math.max(l1, l2) / 2) - 1, 0);
  const s1m = new Uint8Array(l1);
  const s2m = new Uint8Array(l2);
  let matches = 0;

  for (let i = 0; i < l1; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, l2);
    for (let j = lo; j < hi; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue;
      s1m[i] = 1; s2m[j] = 1; matches++; break;
    }
  }

  if (!matches) return 0.0;

  let transpositions = 0, k = 0;
  for (let i = 0; i < l1; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / l1 + matches / l2 + (matches - transpositions / 2) / matches) / 3;
}

function jaroWinkler(s1, s2, p = 0.1) {
  const j = jaro(s1, s2);
  if (j < 0.7) return j;
  let prefix = 0;
  const max = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < max; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return j + prefix * p * (1 - j);
}

// ------------------------------------------------------------
// Jaccard for Sets
// ------------------------------------------------------------
function jaccardSets(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const item of a) if (b.has(item)) n++;
  return n / (a.size + b.size - n);
}

// ------------------------------------------------------------
// Compute final score for a pair.
// ------------------------------------------------------------
function computeScore({ urlExact, handleScore, emailScore, nameSim, genreJ, sameCountry }) {
  // Exact URL → certain.
  if (urlExact) return 1.0;

  const base = Math.max(handleScore, emailScore, nameSim);
  const support = base >= 0.5
    ? 0.04 * genreJ + 0.03 * (sameCountry ? 1 : 0)
    : 0;

  return Math.min(0.99, base + support); // cap at 0.99; 1.0 is reserved for url_exact
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`Min score: ${MIN_SCORE}${NO_URL_EXACT ? "  (--no-url-exact: skipping trivial URL matches)" : ""}`);
  console.log(`Output:    ${OUTPUT_PATH}\n`);

  // --- Load data ---
  process.stdout.write("Loading artists...");
  const artists = await fetchAll((from, to) =>
    supabase
      .from("artists")
      .select("id, name, directory_status, booking_info, management_info, contact_info")
      .eq("deleted", false)
      .order("id")
      .range(from, to)
  );
  console.log(` ${artists.length}`);

  process.stdout.write("Loading links...");
  const allLinks = await fetchAll((from, to) =>
    supabase
      .from("artist_links")
      .select("artist_id, platform, handle, url")
      .order("artist_id")
      .range(from, to)
  );
  console.log(` ${allLinks.length}`);

  process.stdout.write("Loading genres...");
  const allGenres = await fetchAll((from, to) =>
    supabase
      .from("artist_genres")
      .select("artist_id, genres(name)")
      .order("artist_id")
      .range(from, to)
  );
  console.log(` ${allGenres.length}`);

  process.stdout.write("Loading locations...");
  const allLocations = await fetchAll((from, to) =>
    supabase
      .from("artist_locations")
      .select("artist_id, country")
      .order("artist_id")
      .range(from, to)
  );
  console.log(` ${allLocations.length}\n`);

  // --- Index maps ---

  const artistIdx = new Map(artists.map((a, i) => [a.id, i]));

  // artist_id → Set<"genre_name">
  const genresByArtist = new Map();
  for (const row of allGenres) {
    if (!genresByArtist.has(row.artist_id)) genresByArtist.set(row.artist_id, new Set());
    const name = row.genres?.name;
    if (name) genresByArtist.get(row.artist_id).add(name.toLowerCase().trim());
  }

  // artist_id → Set<"country">
  const countriesByArtist = new Map();
  for (const row of allLocations) {
    if (!row.country) continue;
    if (!countriesByArtist.has(row.artist_id)) countriesByArtist.set(row.artist_id, new Set());
    countriesByArtist.get(row.artist_id).add(row.country.toLowerCase().trim());
  }

  // artist_id → [{platform, normalizedUrl, normalizedHandle}]
  // normalizedHandle: prefer the stored `handle` column; fall back to URL extraction.
  const linksByArtist = new Map();
  for (const row of allLinks) {
    if (!linksByArtist.has(row.artist_id)) linksByArtist.set(row.artist_id, []);
    const rawHandle = row.handle || extractHandleFromUrl(row.url);
    linksByArtist.get(row.artist_id).push({
      platform:        row.platform,
      normalizedUrl:   normalizeUrl(row.url),
      rawHandle,
      normalizedHandle: normalizeHandle(rawHandle),
    });
  }

  // artist_id → Set<email> (from booking/management/contact fields)
  const emailsByArtist = new Map();
  for (const artist of artists) {
    const emails = new Set([
      ...extractEmails(artist.booking_info),
      ...extractEmails(artist.management_info),
      ...extractEmails(artist.contact_info),
    ]);
    if (emails.size > 0) emailsByArtist.set(artist.id, emails);
  }

  // normalizedUrl → [{artistId, platform}]  (for exact URL matching)
  const urlToArtists = new Map();
  for (const [artistId, links] of linksByArtist) {
    for (const { platform, normalizedUrl } of links) {
      if (!urlToArtists.has(normalizedUrl)) urlToArtists.set(normalizedUrl, []);
      urlToArtists.get(normalizedUrl).push({ artistId, platform });
    }
  }

  // normalizedHandle → [{artistId, platform, rawHandle}]
  // (used to find cross-platform handle matches — same handle on different platforms)
  const handleToArtists = new Map();
  for (const [artistId, links] of linksByArtist) {
    for (const { platform, normalizedHandle, rawHandle } of links) {
      if (!normalizedHandle) continue;
      if (!handleToArtists.has(normalizedHandle)) handleToArtists.set(normalizedHandle, []);
      handleToArtists.get(normalizedHandle).push({ artistId, platform, rawHandle });
    }
  }

  // email → [artistId] (for shared-email matching)
  const emailToArtists = new Map();
  for (const [artistId, emails] of emailsByArtist) {
    for (const email of emails) {
      if (!emailToArtists.has(email)) emailToArtists.set(email, []);
      emailToArtists.get(email).push(artistId);
    }
  }
  // Suppress emails shared by ≥ 4 artists — likely a booking agency inbox,
  // not an individual artist's address.
  const SHARED_EMAIL_MAX = 4;
  for (const [email, ids] of emailToArtists) {
    if (ids.length >= SHARED_EMAIL_MAX) {
      if (DEBUG) console.log(`  Suppressing common email ${email} (${ids.length} artists)`);
      emailToArtists.delete(email);
    }
  }

  // --- Generate candidate pairs ---
  //
  // Canonical pair key: `${idA}\x00${idB}` with idA < idB to avoid duplicates.
  const candidatePairs = new Set();
  function addPair(idA, idB) {
    if (idA === idB) return;
    candidatePairs.add(idA < idB ? `${idA}\x00${idB}` : `${idB}\x00${idA}`);
  }

  // 1. Exact URL pairs
  for (const [, entries] of urlToArtists) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++)
      for (let j = i + 1; j < entries.length; j++)
        if (entries[i].artistId !== entries[j].artistId)
          addPair(entries[i].artistId, entries[j].artistId);
  }
  if (DEBUG) console.log(`After URL scan: ${candidatePairs.size} pairs`);

  // 2. Cross-platform exact handle matches
  //    (same normalized handle appearing on *different* platforms for *different* artists)
  for (const [, entries] of handleToArtists) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const eA = entries[i], eB = entries[j];
        if (eA.artistId === eB.artistId) continue;  // same artist, different platforms — not interesting
        if (eA.platform === eB.platform) continue;  // same platform → covered by URL exact
        addPair(eA.artistId, eB.artistId);
      }
    }
  }
  if (DEBUG) console.log(`After cross-platform handle scan: ${candidatePairs.size} pairs`);

  // 3. Shared booking/contact email pairs
  for (const [, ids] of emailToArtists) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        addPair(ids[i], ids[j]);
  }
  if (DEBUG) console.log(`After email scan: ${candidatePairs.size} pairs`);

  // 4. Name-based pairs with blocking
  //    Blocking keys: first 4 chars of normalized name + each word ≥ 4 chars.
  //    Only emit a candidate pair when Jaro-Winkler ≥ 0.82.
  const nameBlocks = new Map();
  const normalizedNames = new Map();

  for (const artist of artists) {
    const norm = normalizeName(artist.name);
    normalizedNames.set(artist.id, norm);
    if (norm.length >= 2) {
      const pfxKey = "p:" + norm.slice(0, 4);
      if (!nameBlocks.has(pfxKey)) nameBlocks.set(pfxKey, []);
      nameBlocks.get(pfxKey).push(artist.id);
    }
    for (const word of norm.split(" ")) {
      if (word.length >= 4) {
        const tokKey = "t:" + word;
        if (!nameBlocks.has(tokKey)) nameBlocks.set(tokKey, []);
        nameBlocks.get(tokKey).push(artist.id);
      }
    }
  }

  let nameComparisons = 0;
  for (const [, ids] of nameBlocks) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        nameComparisons++;
        const nA = normalizedNames.get(ids[i]);
        const nB = normalizedNames.get(ids[j]);
        if (jaroWinkler(nA, nB) >= 0.82) addPair(ids[i], ids[j]);
      }
    }
  }
  if (DEBUG) {
    console.log(`Name block comparisons: ${nameComparisons}`);
    console.log(`Total candidate pairs:  ${candidatePairs.size}`);
  }
  console.log(`Scoring ${candidatePairs.size} candidate pairs...\n`);

  // --- Score each pair ---
  const results = [];

  for (const pairKey of candidatePairs) {
    const [idA, idB] = pairKey.split("\x00");
    const idxA = artistIdx.get(idA);
    const idxB = artistIdx.get(idB);
    if (idxA === undefined || idxB === undefined) continue;

    const artistA = artists[idxA];
    const artistB = artists[idxB];

    const linksA = linksByArtist.get(idA) ?? [];
    const linksB = linksByArtist.get(idB) ?? [];
    const signals = [];

    // — Signal 1: exact URL match —
    const normUrlsB = new Map(linksB.map((l) => [l.normalizedUrl, l.platform]));
    let urlExact = false;
    const exactPlatforms = [];
    for (const lA of linksA) {
      const platB = normUrlsB.get(lA.normalizedUrl);
      if (platB !== undefined) {
        urlExact = true;
        exactPlatforms.push(lA.platform);
      }
    }
    if (urlExact) {
      for (const p of [...new Set(exactPlatforms)]) signals.push(`url_exact:${p}`);
    }

    // Skip trivial URL-exact pairs if --no-url-exact was passed.
    if (urlExact && NO_URL_EXACT) continue;

    // — Signal 2: cross-platform handle similarity —
    //
    // For every combination of (handle from A's links, handle from B's links)
    // where the platforms are DIFFERENT, compute Jaro-Winkler on the
    // normalized handles. We only look across platforms because same-platform
    // handle similarity just restates the URL comparison.
    let handleScore = 0;
    let bestHandleSignal = null;

    for (const lA of linksA) {
      if (!lA.normalizedHandle) continue;
      for (const lB of linksB) {
        if (!lB.normalizedHandle) continue;
        if (lA.platform === lB.platform) continue; // same platform → not a new signal
        const sim = jaroWinkler(lA.normalizedHandle, lB.normalizedHandle);
        if (sim < 0.88) continue;

        // Score: exact cross-platform handle match → 0.90; fuzzy → scaled down to 0.80.
        const s = sim === 1.0 ? 0.90 : 0.80 + (sim - 0.88) * (10 / 12 * 0.10);
        if (s > handleScore) {
          handleScore = s;
          // Label: include a concise platform abbreviation pair and the raw handle
          const pfmA = platformAbbr(lA.platform);
          const pfmB = platformAbbr(lB.platform);
          const handleDisplay = lA.normalizedHandle === lB.normalizedHandle
            ? lA.normalizedHandle
            : `${lA.rawHandle ?? lA.normalizedHandle}/${lB.rawHandle ?? lB.normalizedHandle}`;
          bestHandleSignal = sim === 1.0
            ? `handle_cross:${handleDisplay}(${pfmA}↔${pfmB})`
            : `handle_fuzzy:${sim.toFixed(3)}:${handleDisplay}(${pfmA}↔${pfmB})`;
        }
      }
    }
    if (bestHandleSignal) signals.push(bestHandleSignal);

    // — Signal 3: shared booking/contact email —
    const emailsA = emailsByArtist.get(idA) ?? new Set();
    const emailsB = emailsByArtist.get(idB) ?? new Set();
    let emailScore = 0;
    const sharedEmails = [];
    for (const email of emailsA) {
      if (emailsB.has(email) && emailToArtists.has(email)) {
        sharedEmails.push(email);
        emailScore = 0.80;
      }
    }
    if (sharedEmails.length > 0) {
      signals.push(`same_email:${sharedEmails[0]}`);
    }

    // — Signal 4: name similarity —
    const nA = normalizedNames.get(idA) ?? normalizeName(artistA.name);
    const nB = normalizedNames.get(idB) ?? normalizeName(artistB.name);
    const nameSim = jaroWinkler(nA, nB);
    if (nA === nB) {
      signals.push("name_exact");
    } else if (nameSim >= 0.80) {
      signals.push(`name_fuzzy:${nameSim.toFixed(3)}`);
    }

    // — Supporting signals —
    const genresA = genresByArtist.get(idA) ?? new Set();
    const genresB = genresByArtist.get(idB) ?? new Set();
    const genreJ  = jaccardSets(genresA, genresB);

    const countriesA = countriesByArtist.get(idA) ?? new Set();
    const countriesB = countriesByArtist.get(idB) ?? new Set();
    let sameCountry = false;
    for (const c of countriesA) { if (countriesB.has(c)) { sameCountry = true; break; } }

    if (genreJ >= 0.25) signals.push(`genre_overlap:${genreJ.toFixed(2)}`);
    if (sameCountry)    signals.push("same_country");

    // — Final score —
    const score = computeScore({ urlExact, handleScore, emailScore, nameSim, genreJ, sameCountry });
    if (score < MIN_SCORE) continue;

    const confidence = score >= 0.90 ? "very likely" : score >= 0.75 ? "possible" : "low";

    results.push({
      artist_id_a: idA,
      name_a:      artistA.name,
      status_a:    artistA.directory_status ?? "unknown",
      artist_id_b: idB,
      name_b:      artistB.name,
      status_b:    artistB.directory_status ?? "unknown",
      score:       +score.toFixed(4),
      confidence,
      signals:     signals.join(", "),
    });
  }

  results.sort((a, b) => b.score - a.score);

  // --- Write CSV ---
  const COLS = [
    "artist_id_a", "name_a", "status_a",
    "artist_id_b", "name_b", "status_b",
    "score", "confidence", "signals",
  ];

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const csvLines = [COLS.join(",") + "\n"];
  for (const r of results) {
    csvLines.push(COLS.map((c) => csvEscape(r[c])).join(",") + "\n");
  }
  fs.writeFileSync(OUTPUT_PATH, csvLines.join(""), "utf-8");

  // --- Summary ---
  const veryLikely = results.filter((r) => r.confidence === "very likely").length;
  const possible   = results.filter((r) => r.confidence === "possible").length;
  const low        = results.filter((r) => r.confidence === "low").length;

  console.log(`Found ${results.length} candidate pair(s) at score ≥ ${MIN_SCORE}.`);
  console.log(`  Very likely  (≥ 0.90): ${veryLikely}`);
  console.log(`  Possible     (≥ 0.75): ${possible}`);
  console.log(`  Low          (< 0.75): ${low}`);
  console.log(`\nOutput: ${OUTPUT_PATH}`);
}

// Short abbreviation for a platform name used in signal labels.
function platformAbbr(platform) {
  const MAP = {
    soundcloud:       "sc",
    instagram:        "ig",
    resident_advisor: "ra",
    bandcamp:         "bc",
    beatport:         "bp",
    discogs:          "dg",
    apple_music:      "am",
    spotify:          "sp",
    qobuz:            "qb",
    homepage:         "web",
    wikipedia:        "wp",
    linktree:         "lt",
    other:            "?",
  };
  return MAP[platform] ?? platform;
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
