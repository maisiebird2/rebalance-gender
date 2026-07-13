#!/usr/bin/env node
// ============================================================
// AI bio summaries.
//
// The site does not display raw platform bios directly. Instead,
// every artist's displayed bio is a short (<= ~100 word) AI summary
// synthesised from the source bios we've harvested (Discogs, Linktree,
// Hoer, SoundCloud, Bandcamp, etc.).
//
// For each artist that has at least one source bio, this script:
//   1. Gathers all their source bios (every `biographies` row EXCEPT
//      the summary itself), plus the city + genres already shown on
//      their page.
//   2. Asks Claude (Haiku) to write a short factual summary, with
//      instructions to:
//        - exclude lists of upcoming/past shows, tour dates or events
//          (a date paired with a venue/city),
//        - NOT restate the city or genres (those are already on the
//          page), and
//        - return an empty summary when there is nothing meaningful
//          left to say. A blank bio is a valid, preferred outcome —
//          we never manufacture filler.
//   3. Upserts the result back into `biographies` as a row with
//      platform = 'claude_summary'. An empty summary is stored as a
//      row with bio = NULL, which both marks the artist as processed
//      and tells the frontend to show no bio.
//
// The summary row's `source_url` is stamped with the model id for
// auditing. Re-runs are incremental: an artist is only (re)summarised
// when one of its source bios is newer than its existing summary
// (or with --force).
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/summarize-bios.mjs                 # summarise artists whose summary is missing or stale
//   node scripts/summarize-bios.mjs --limit=20      # only the first 20 (sanity-check before a full run)
//   node scripts/summarize-bios.mjs --force         # re-summarise everyone, even if up to date
//   node scripts/summarize-bios.mjs --all-statuses  # include non-approved artists (default: approved only)
//   node scripts/summarize-bios.mjs --name="DJ Minx"# only artists whose name contains this (case-insensitive)
//   node scripts/summarize-bios.mjs --concurrency=4 # parallel API calls (default 4)
//   node scripts/summarize-bios.mjs --model=claude-haiku-4-5   # override the model
//   node scripts/summarize-bios.mjs --debug         # log the prompt + raw model output per artist
//   DRY_RUN=1 node scripts/summarize-bios.mjs       # do everything except write to the DB
//
// Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
// and ANTHROPIC_API_KEY.
//
// Cost: one Haiku call per stale artist. For ~2,000 artists a full
// run is roughly $3-5 of Anthropic API spend (billed to your API
// account, separate from any Claude subscription). Start with --limit
// to eyeball the output before running on everything.
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
// Summaries are only displayed for approved artists, so we default to
// approved-only. Pass --all-statuses to also summarise pending/other artists
// (e.g. to pre-compute a summary before approval).
const ALL_STATUSES = args.includes("--all-statuses");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concurrencyArg
  ? Math.max(1, parseInt(concurrencyArg.split("=")[1], 10))
  : 4;
const modelArg = args.find((a) => a.startsWith("--model="));
const MODEL = modelArg ? modelArg.slice("--model=".length) : "claude-haiku-4-5";

const SUMMARY_PLATFORM = "claude_summary";

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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY.\n" +
      "Add it to .env.local before running (see .env.local.example)."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Prompt
// ------------------------------------------------------------
const SYSTEM_PROMPT = `You write concise biographies for artists in a music directory.

You are given an artist's name, the facts already shown elsewhere on their page (their city and their music genres), and one or more source bios harvested from music platforms. Write a single short biography that synthesises the source bios.

Rules:
- Maximum ~100 words. Shorter is fine and better when the sources are thin. Never pad.
- Plain prose. One or two short paragraphs, no headings, no markdown, no lists, no emoji.
- Only state facts supported by the source bios. Never invent, guess, or embellish.
- EXCLUDE listings of shows, gigs, tour dates or events — anything that pairs a date with a venue, festival or city. Do not reproduce upcoming-show schedules or past-appearance lists.
- Do NOT restate the artist's city/location or their genres — those are already shown on the page. Mention a place or a style only when it carries real biographical meaning (e.g. where they came up, a scene they helped shape), not as a bare label.
- Prefer durable biographical substance: background, how they came to the music, notable releases and labels, collaborations, roles, distinctive scene context.
- If, after removing show lists and the already-shown city/genres, there is nothing meaningful left to say, return an empty string. A blank bio is the correct, preferred output in that case — do not manufacture a sentence just to have one.

Output ONLY the biography text (or an empty string). No preamble, no quotation marks, no explanation.`;

function buildUserContent(artist) {
  const lines = [];
  lines.push(`Artist: ${artist.name}`);

  const alreadyShown = [];
  if (artist.places.length) alreadyShown.push(`City/location: ${artist.places.join("; ")}`);
  if (artist.genres.length) alreadyShown.push(`Genres: ${artist.genres.join(", ")}`);
  if (alreadyShown.length) {
    lines.push("");
    lines.push("Already shown on the page (do NOT restate these):");
    lines.push(...alreadyShown);
  }

  lines.push("");
  lines.push("Source bios:");
  for (const b of artist.bios) {
    lines.push("");
    lines.push(`[${b.platform}]`);
    lines.push(b.bio.trim());
  }
  return lines.join("\n");
}

// ------------------------------------------------------------
// Anthropic Messages API (raw fetch — no SDK dependency)
// ------------------------------------------------------------
async function summariseWithClaude(artist) {
  const body = {
    model: MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserContent(artist) }],
  };

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network error — back off and retry.
      if (attempt === maxAttempts) throw err;
      await sleep(1000 * attempt);
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return text;
    }

    // Retry on rate limit / overload / server errors, honouring Retry-After.
    if (res.status === 429 || res.status >= 500) {
      if (attempt === maxAttempts) {
        const errText = await res.text();
        throw new Error(`Anthropic ${res.status} after ${maxAttempts} attempts: ${errText}`);
      }
      const retryAfter = parseFloat(res.headers.get("retry-after") || "");
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
      await sleep(waitMs);
      continue;
    }

    // Non-retryable (400/401/403/404...) — surface immediately.
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }
  throw new Error("unreachable");
}

// ------------------------------------------------------------
// Gather source bios + context per artist
// ------------------------------------------------------------
async function loadArtists() {
  // All source bios (everything except our own summary rows).
  const bios = await fetchAll("biographies", "artist_id, platform, bio, updated_at", (q) =>
    q.neq("platform", SUMMARY_PLATFORM)
  );

  // Existing summary rows, to decide what's stale.
  const summaries = await fetchAll("biographies", "artist_id, updated_at", (q) =>
    q.eq("platform", SUMMARY_PLATFORM)
  );
  const summaryUpdatedAt = new Map(summaries.map((s) => [s.artist_id, s.updated_at]));

  // Group source bios by artist.
  const byArtist = new Map();
  for (const b of bios) {
    if (!b.bio || !b.bio.trim()) continue; // skip empty source rows
    if (!byArtist.has(b.artist_id)) byArtist.set(b.artist_id, []);
    byArtist.get(b.artist_id).push(b);
  }

  const artistIds = [...byArtist.keys()];
  if (artistIds.length === 0) return [];

  // Artist names + status. The artists table is very large (100k+ rows), so we
  // look up only the candidate ids — chunked, because a single .in() with ~1000
  // UUIDs overruns PostgREST's URL length limit.
  const artistRows = await fetchByIds("artists", "id, name, directory_status", "id", artistIds, (q) =>
    q.eq("deleted", false)
  );
  const artistInfo = new Map(artistRows.map((a) => [a.id, a]));

  // Cities/locations.
  const locRows = await fetchByIds(
    "artist_locations",
    "artist_id, city, country",
    "artist_id",
    artistIds
  );
  const placesByArtist = new Map();
  for (const l of locRows) {
    const place = [l.city, l.country].filter(Boolean).join(", ");
    if (!place) continue;
    if (!placesByArtist.has(l.artist_id)) placesByArtist.set(l.artist_id, new Set());
    placesByArtist.get(l.artist_id).add(place);
  }

  // Genres (join artist_genres -> genres.name).
  const genreLinks = await fetchByIds(
    "artist_genres",
    "artist_id, genre_id",
    "artist_id",
    artistIds
  );
  const genreIds = [...new Set(genreLinks.map((g) => g.genre_id))];
  const genreRows = genreIds.length
    ? await fetchByIds("genres", "id, name", "id", genreIds)
    : [];
  const genreName = new Map(genreRows.map((g) => [g.id, g.name]));
  const genresByArtist = new Map();
  for (const g of genreLinks) {
    const name = genreName.get(g.genre_id);
    if (!name) continue;
    if (!genresByArtist.has(g.artist_id)) genresByArtist.set(g.artist_id, new Set());
    genresByArtist.get(g.artist_id).add(name);
  }

  // Assemble.
  let artists = [];
  for (const [artistId, artistBios] of byArtist) {
    const info = artistInfo.get(artistId);
    if (!info) continue; // deleted or filtered out
    if (!ALL_STATUSES && info.directory_status !== "approved") continue;
    if (NAME_FILTER && !info.name.toLowerCase().includes(NAME_FILTER.toLowerCase())) continue;

    const newestSource = artistBios.reduce(
      (max, b) => (b.updated_at > max ? b.updated_at : max),
      artistBios[0].updated_at
    );
    const existing = summaryUpdatedAt.get(artistId);
    const stale = !existing || existing < newestSource;
    if (!FORCE && !stale) continue;

    artists.push({
      id: artistId,
      name: info.name,
      bios: artistBios.sort((a, b) => a.platform.localeCompare(b.platform)),
      places: [...(placesByArtist.get(artistId) || [])],
      genres: [...(genresByArtist.get(artistId) || [])],
    });
  }

  // Deterministic order so --limit is reproducible.
  artists.sort((a, b) => a.name.localeCompare(b.name));
  if (LIMIT != null) artists = artists.slice(0, LIMIT);
  return artists;
}

// Paginated fetch of a whole (filtered) table — supabase caps rows per request
// at 1000, so page through with .range(). Use only for small tables/result sets.
async function fetchAll(table, columns, applyFilters, orderColumn = "artist_id") {
  const pageSize = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    let q = supabase.from(table).select(columns).order(orderColumn, { ascending: true });
    q = applyFilters(q).range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw new Error(`Query on ${table} failed: ${error.message}`);
    out.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

// Fetch rows whose `idColumn` is in `ids`, in chunks. A single .in() with ~1000
// UUIDs overruns PostgREST's URL length limit, so batch the ids and page within
// each batch in case a chunk returns more than 1000 rows.
async function fetchByIds(table, columns, idColumn, ids, applyFilters = (q) => q) {
  const chunkSize = 150;
  const out = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let from = 0;
    for (;;) {
      let q = supabase
        .from(table)
        .select(columns)
        .in(idColumn, chunk)
        .order(idColumn, { ascending: true });
      q = applyFilters(q).range(from, from + 999);
      const { data, error } = await q;
      if (error) throw new Error(`Query on ${table} failed: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }
  }
  return out;
}

// ------------------------------------------------------------
// Write summary back
// ------------------------------------------------------------
async function writeSummary(artistId, summary) {
  const bio = summary && summary.trim() ? summary.trim() : null;
  if (DRY_RUN) return;
  const { error } = await supabase
    .from("biographies")
    .upsert(
      {
        artist_id: artistId,
        platform: SUMMARY_PLATFORM,
        bio,
        source_url: MODEL,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "artist_id,platform" }
    );
  if (error) throw new Error(`Upsert failed for ${artistId}: ${error.message}`);
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    `summarize-bios: model=${MODEL} concurrency=${CONCURRENCY}` +
      ` statuses=${ALL_STATUSES ? "all" : "approved-only"}` +
      `${FORCE ? " --force" : ""}` +
      `${LIMIT != null ? ` --limit=${LIMIT}` : ""}${DRY_RUN ? " DRY_RUN" : ""}`
  );

  const artists = await loadArtists();
  console.log(`${artists.length} artist(s) to summarise.\n`);
  if (artists.length === 0) return;

  let done = 0;
  let written = 0;
  let blanks = 0;
  let failed = 0;

  // Simple fixed-size worker pool over the artist list.
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= artists.length) return;
      const artist = artists[i];
      try {
        const summary = await summariseWithClaude(artist);
        if (DEBUG) {
          console.log(`\n----- ${artist.name} -----`);
          console.log(buildUserContent(artist));
          console.log(`>>> ${summary ? summary : "(blank)"}`);
        }
        await writeSummary(artist.id, summary);
        if (summary && summary.trim()) written++;
        else blanks++;
      } catch (err) {
        failed++;
        console.error(`  FAIL ${artist.name}: ${err.message}`);
      }
      done++;
      if (done % 25 === 0 || done === artists.length) {
        console.log(`  ${done}/${artists.length} (written=${written} blank=${blanks} failed=${failed})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, artists.length) }, worker));

  console.log(
    `\nDone. ${written} summary/summaries written, ${blanks} left blank, ${failed} failed.` +
      `${DRY_RUN ? " (DRY_RUN — nothing written)" : ""}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
