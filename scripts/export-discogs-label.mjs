#!/usr/bin/env node
// ============================================================
// export-discogs-label.mjs — one label's Discogs discography as a CSV,
// with the artist behind every release and whether we already hold them.
//
// Reads the official Discogs API and writes one row per
// (release, artist) pair:
//
//   artist_name      — the artist's canonical Discogs name, verbatim
//                      (so "Sims (2)" keeps its disambiguator — that is
//                      the name on the profile the URL points at)
//   artist_url       — https://www.discogs.com/artist/<id>
//   release_title    — the release title
//   release_url      — the release's public Discogs page
//   catalog_number   — catno as the label listing gives it
//   year             — release year, blank when Discogs has none (it
//                      stores "unknown" as 0)
//   db_artist_name   — our artists.name for the artist this row was
//   db_artist_id     — matched to, and its UUID. BLANK when nothing
//                      matched — see below.
//   db_match         — which step matched: 'link', 'name', or one of
//                      'link_ambiguous' / 'name_ambiguous'
//
// A release with several credited artists produces several rows, which
// is what makes the sheet useful as an artist list: dedupe on
// artist_url and you have the label's roster, with the artists we don't
// have yet showing as blank db_ columns.
//
// The two matching steps live in scripts/lib/discogs-artist-match.mjs:
// first the artist's Discogs URL against the platform='discogs' rows in
// artist_links (compared by numeric artist id, since the stored URLs
// aren't normalized), then — only for what that missed — the Discogs
// name normalized exactly the way the artists.name_search generated
// column normalizes ours. Where more than one live artist answers,
// db_artist_name and db_artist_id stay BLANK and db_match records the
// ambiguity; the run prints those so a human can settle them. Pass
// --no-db to skip matching entirely and leave all three columns blank.
//
// Two API calls per release-list page, then ONE call per release. The
// label listing (GET /labels/{id}/releases) carries only a display
// string for the artist ("Ben Sims & Vincent D*") and no artist id, so
// the artist URLs — and with them step 1 of the matching — have to come
// from the release resource itself. At the authenticated rate limit
// that is ~1.1s per release; a 140-release label takes about three
// minutes. --fast skips that pass when the artist names alone will do
// (matching then falls back to step 2 for everyone).
//
// Compilations: a release credited to "Various" names no one, so by
// default the tracklist's per-track artists are emitted in its place
// (no extra API call — the release payload already carries the
// tracklist). --no-expand-various keeps the single "Various" row.
//
// A caveat worth knowing before reading the output: /labels/{id}/releases
// returns exactly what the label's page on discogs.com lists, and that
// listing is broader than "released by this label" — a handful of mix
// CDs and DVDs that merely credit the label somewhere come along with
// it (Hardgroove's listing includes Jeff Mills' "Exhibitionist" DVD).
// Pass --labels-only to keep just the releases whose own label credits
// name this label, at the cost of nothing extra — the check runs off
// the release payload already fetched.
//
// Usage (from rebalance-gender/):
//
//   node scripts/export-discogs-label.mjs https://www.discogs.com/label/843-Hardgroove
//   node scripts/export-discogs-label.mjs 843
//   node scripts/export-discogs-label.mjs 843 --labels-only
//   node scripts/export-discogs-label.mjs 843 --limit=10 --out=hardgroove.csv
//   node scripts/export-discogs-label.mjs 843 --fast     # no artist URLs
//   node scripts/export-discogs-label.mjs 843 --no-db    # no DB matching
//
// The CSV lands in the shared output folder (<repo>/../output files) —
// see documentation/OUTPUT-FILE-LOCATION.md. This script only ever
// READS the database.
//
// Requires .env.local: DISCOGS_TOKEN, plus NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SECRET_KEY unless --no-db.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import fs from "node:fs";
import { createSupabase, loadEnvLocal, makeFetchAll } from "./lib/hoer-db.mjs";
import { matchDiscogsArtists } from "./lib/discogs-artist-match.mjs";
import { outputPath } from "./lib/output-path.mjs";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const FAST = args.includes("--fast");
const LABELS_ONLY = args.includes("--labels-only");
const EXPAND_VARIOUS = !args.includes("--no-expand-various");
const MATCH_DB = !args.includes("--no-db");
const limitArg = argValue("limit");
const LIMIT = limitArg ? parseInt(limitArg, 10) : null;
const OUT_ARG = argValue("out");
const TARGET = args.find((a) => !a.startsWith("--"));

function usage(message) {
  console.error(`${message}\n`);
  console.error("Usage: node scripts/export-discogs-label.mjs <label-url-or-id> [options]");
  console.error("  --out=NAME.csv        output filename (default: discogs-label-<name>-<stamp>.csv)");
  console.error("  --limit=N             only the first N releases (for testing)");
  console.error("  --fast                skip the per-release call: no artist URLs, one row per release");
  console.error("  --labels-only         drop releases whose own label credits don't name this label");
  console.error("  --no-expand-various   keep 'Various' instead of listing the tracklist's artists");
  console.error("  --no-db               skip the database matching; db_ columns stay blank");
  process.exit(1);
}

if (!TARGET) usage("Missing the label to export.");
if (FAST && LABELS_ONLY) usage("--fast and --labels-only conflict: the label check needs the per-release call.");

loadEnvLocal();

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
if (!DISCOGS_TOKEN) {
  console.error(
    "Missing DISCOGS_TOKEN in .env.local.\n" +
      "Create a personal access token at https://www.discogs.com/settings/developers"
  );
  process.exit(1);
}

// ------------------------------------------------------------
// Discogs API — same throttle and 429 handling as sync-discogs.mjs
// ------------------------------------------------------------
const THROTTLE_MS = 1100; // ~55 req/min, under the 60/min authenticated cap
const USER_AGENT = "RebalanceGender/1.0 +https://rebalance-gender.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

/**
 * GET a Discogs resource. Waits out a 429 the way the header asks, and
 * retries a network error or 5xx twice before giving up.
 *
 * @returns {Promise<{ok: boolean, status: number|null, data: any, error: string|null}>}
 */
async function discogsGet(url, { attempt = 1 } = {}) {
  await throttle();
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Authorization: `Discogs token=${DISCOGS_TOKEN}` },
    });
  } catch (err) {
    if (attempt < 3) return discogsGet(url, { attempt: attempt + 1 });
    return { ok: false, status: null, data: null, error: String(err?.message ?? err) };
  }
  if (res.status === 429 && attempt < 4) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    console.log(`  rate-limited; waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return discogsGet(url, { attempt: attempt + 1 });
  }
  if (res.status >= 500 && attempt < 3) return discogsGet(url, { attempt: attempt + 1 });
  if (!res.ok) return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}` };
  return { ok: true, status: res.status, data: await res.json(), error: null };
}

/**
 * The numeric label id from whatever the user typed: a bare id, a label
 * URL (with or without the name slug, with or without a /xx/ locale
 * prefix), or a bare discogs.com path.
 */
function labelIdFromArg(raw) {
  const trimmed = String(raw).trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/discogs\.com\/(?:[a-z]{2}\/)?label\/(\d+)/i);
  return m ? m[1] : null;
}

// ------------------------------------------------------------
// Shaping
// ------------------------------------------------------------
const VARIOUS_ID = 194; // Discogs' catch-all "Various" artist

const artistUrl = (id) => (id ? `https://www.discogs.com/artist/${id}` : "");

/** Stable identifier for one Discogs artist across the releases it appears on. */
const artistKey = (artist) =>
  artist.id ? `id:${artist.id}` : `name:${artist.name.toLowerCase()}`;

/** Public page for a release, from the detail payload or its id. */
function releaseUrl(detail, listing) {
  const uri = typeof detail?.uri === "string" ? detail.uri.trim() : "";
  if (uri) return uri;
  const kind = /\/masters\/\d+/.test(String(listing.resource_url)) ? "master" : "release";
  return `https://www.discogs.com/${kind}/${listing.id}`;
}

/** Named credits only, deduped by artist id (falling back to name). */
function credits(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const key = entry.id ? `id:${entry.id}` : `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, id: entry.id ?? null });
  }
  return out;
}

/**
 * Who to credit for one release. The release's own artists, except that
 * a compilation credited to "Various" is replaced by the artists named
 * on its tracklist — "Various" is not a person and carries no useful URL.
 * Falls back to the listing's display string when there is no detail
 * payload (--fast, or a release that failed to fetch), with no URL.
 */
function artistsForRelease(listing, detail) {
  const main = credits(detail?.artists);
  const isVarious =
    main.length === 1 && (main[0].id === VARIOUS_ID || main[0].name.toLowerCase() === "various");
  if (isVarious && EXPAND_VARIOUS) {
    const perTrack = credits((detail?.tracklist ?? []).flatMap((t) => t?.artists ?? []));
    if (perTrack.length) return perTrack;
  }
  if (main.length) return main;
  const fallback = typeof listing.artist === "string" ? listing.artist.trim() : "";
  return [{ name: fallback, id: null }];
}

/** Does this release's own label credit name the label we asked about? */
function creditsLabel(detail, labelId) {
  const entries = Array.isArray(detail?.labels) ? detail.labels : [];
  return entries.some((l) => String(l?.id) === String(labelId));
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "label";

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  const labelId = labelIdFromArg(TARGET);
  if (!labelId) usage(`Not a Discogs label URL or id: ${TARGET}`);

  const label = await discogsGet(`https://api.discogs.com/labels/${labelId}`);
  if (!label.ok) {
    console.error(`Could not read label ${labelId}: ${label.error}`);
    process.exit(1);
  }
  const labelName = label.data?.name ?? `label-${labelId}`;
  console.log(`Label: ${labelName} (${labelId}) — ${label.data?.uri ?? ""}`);

  // ── 1. The label listing, paginated ────────────────────────
  const listings = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await discogsGet(
      `https://api.discogs.com/labels/${labelId}/releases?per_page=100&page=${page}`
    );
    if (!res.ok) {
      console.error(`Failed on releases page ${page}: ${res.error}`);
      process.exit(1);
    }
    pages = res.data?.pagination?.pages ?? 1;
    listings.push(...(res.data?.releases ?? []));
    page += 1;
  } while (page <= pages);

  // Catalogue order reads best for a discography: catno first (numeric
  // so "Hardgroove 2" sorts before "Hardgroove 10"), then year, then title.
  listings.sort(
    (a, b) =>
      String(a.catno ?? "").localeCompare(String(b.catno ?? ""), undefined, {
        numeric: true,
        sensitivity: "base",
      }) ||
      (a.year ?? 0) - (b.year ?? 0) ||
      String(a.title ?? "").localeCompare(String(b.title ?? ""))
  );

  const selected = LIMIT ? listings.slice(0, LIMIT) : listings;
  console.log(`Releases listed: ${listings.length}${LIMIT ? ` (taking ${selected.length})` : ""}`);

  // ── 2. One call per release, for the artist ids ────────────
  const entries = []; // { listing, detail, artists }
  const distinctArtists = new Map(); // key -> { key, name, discogsId }
  let failed = 0;
  let dropped = 0;

  for (const [i, listing] of selected.entries()) {
    let detail = null;
    if (!FAST) {
      const res = await discogsGet(
        listing.resource_url ?? `https://api.discogs.com/releases/${listing.id}`
      );
      if (res.ok) {
        detail = res.data;
      } else {
        failed += 1;
        console.log(`  ! release ${listing.id} (${listing.title}): ${res.error}`);
      }
      if ((i + 1) % 10 === 0 || i + 1 === selected.length) {
        console.log(`  fetched ${i + 1}/${selected.length} releases`);
      }
    }

    if (LABELS_ONLY && detail && !creditsLabel(detail, labelId)) {
      dropped += 1;
      continue;
    }

    const artists = artistsForRelease(listing, detail);
    for (const artist of artists) {
      const key = artistKey(artist);
      if (!distinctArtists.has(key)) {
        distinctArtists.set(key, { key, name: artist.name, discogsId: artist.id });
      }
    }
    entries.push({ listing, detail, artists });
  }

  // ── 3. Match the artists against the database ──────────────
  let matches = new Map();
  if (MATCH_DB && distinctArtists.size) {
    console.log(`\nMatching ${distinctArtists.size} artists against the database...`);
    const fetchAll = makeFetchAll(createSupabase());
    matches = await matchDiscogsArtists({ fetchAll, artists: [...distinctArtists.values()] });
  }

  // ── 4. Write the CSV ───────────────────────────────────────
  const rows = [];
  for (const { listing, detail, artists } of entries) {
    const url = releaseUrl(detail, listing);
    const year = listing.year || detail?.year || "";
    for (const artist of artists) {
      const match = matches.get(artistKey(artist));
      rows.push([
        artist.name,
        artistUrl(artist.id),
        listing.title ?? detail?.title ?? "",
        url,
        listing.catno ?? "",
        year,
        match?.name ?? "",
        match?.id ?? "",
        match?.method ?? "",
      ]);
    }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const out = OUT_ARG ?? `discogs-label-${slugify(labelName)}-${stamp}.csv`;
  const header = [
    "artist_name",
    "artist_url",
    "release_title",
    "release_url",
    "catalog_number",
    "year",
    "db_artist_name",
    "db_artist_id",
    "db_match",
  ];
  const csv =
    [header.join(",")].concat(rows.map((r) => r.map(csvCell).join(","))).join("\n") + "\n";
  const abs = outputPath(out);
  fs.writeFileSync(abs, csv);

  // ── 5. What the run found ──────────────────────────────────
  console.log(`\nRows: ${rows.length}`);
  console.log(`Distinct artists: ${distinctArtists.size}`);
  if (dropped) console.log(`Dropped (label not credited on the release): ${dropped}`);
  if (failed) console.log(`Releases whose detail call failed (name only, no URL): ${failed}`);
  if (FAST) console.log("--fast: artist_url is blank for every row.");

  if (MATCH_DB) {
    const tally = (method) =>
      [...distinctArtists.keys()].filter((k) => (matches.get(k)?.method ?? null) === method).length;
    console.log(`\nIn the database:`);
    console.log(`  matched on their Discogs link: ${tally("link")}`);
    console.log(`  matched on name only:          ${tally("name")}`);
    console.log(`  ambiguous (left blank):        ${tally("link_ambiguous") + tally("name_ambiguous")}`);
    console.log(`  not found:                     ${tally(null)}`);

    const ambiguous = [...distinctArtists.values()].filter((a) =>
      (matches.get(a.key)?.method ?? "").endsWith("_ambiguous")
    );
    for (const artist of ambiguous) {
      const candidates = matches.get(artist.key).candidates;
      console.log(
        `  ? ${artist.name} — ${candidates.length} live artists: ${candidates
          .map((c) => `${c.name} (${c.id})`)
          .join(", ")}`
      );
    }
  }

  console.log(`\nWrote ${abs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
