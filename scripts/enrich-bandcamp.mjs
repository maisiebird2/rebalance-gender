#!/usr/bin/env node
// ============================================================
// Bandcamp discography enrichment.
//
// For each artist with a Bandcamp profile link, fetches their
// Bandcamp page and scrapes the music grid to collect all
// albums and tracks listed there. Stores the results in the
// artist_bandcamp_albums table with the order they appear on
// the page (sort_order, 0-based).
//
// The numeric IDs stored here are what Bandcamp's embedded
// player requires — e.g.:
//   https://bandcamp.com/EmbeddedPlayer/album=467107251/...
//
// No API keys required. Uses one HTTP request per artist
// with a short delay between requests to be polite.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/enrich-bandcamp.mjs                  # artists missing bandcamp albums
//   node scripts/enrich-bandcamp.mjs --limit=20       # only the first 20 (for testing)
//   node scripts/enrich-bandcamp.mjs --force          # re-fetch even artists already scraped
//   DRY_RUN=1 node scripts/enrich-bandcamp.mjs        # fetch + log, don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

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
// HTML parsing
//
// Bandcamp music-grid items look like:
//   <li class="music-grid-item ..."
//       data-item-id="album-467107251"
//       data-band-id="821915681" ...>
//     <a href="/album/space-is-the-key">
//       <div class="art"><img .../></div>
//       <p class="title">Space Is The Key</p>
//     </a>
//   </li>
// ------------------------------------------------------------

// Match each <li> in the music grid that has a data-item-id
const LI_REGEX =
  /<li[^>]+data-item-id="(album|track)-(\d+)"[^>]*>([\s\S]*?)<\/li>/g;

// Within a matched <li>, extract the relative href and title
const HREF_REGEX = /href="(\/(?:album|track)\/[^"]+)"/;
const TITLE_REGEX = /<p[^>]*class="title"[^>]*>([^<]+)<\/p>/;

function parseMusicGrid(html, baseUrl) {
  const items = [];
  let match;
  let sortOrder = 0;

  // Strip any trailing slash from the base URL
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
// Fetch a Bandcamp artist page. Tries /music first (shows the
// full discography grid), falls back to the root if /music
// returns nothing useful.
// ------------------------------------------------------------
async function fetchBandcampPage(artistUrl) {
  const base = artistUrl.replace(/\/+$/, "");

  for (const url of [`${base}/music`, base]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +discography enrichment)",
          Accept: "text/html",
        },
        redirect: "follow",
      });

      if (!res.ok) continue;

      const html = await res.text();

      // Only use this page if it actually has music-grid items
      if (/data-item-id="(?:album|track)-\d+"/.test(html)) {
        return { html, resolvedBase: base };
      }
    } catch {
      // timeout or network error — try next URL
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : `Enriching Bandcamp discographies${FORCE ? " (force re-fetch)" : ""}\n`
  );

  // Fetch artists that have a Bandcamp link.
  // Paginate — PostgREST caps a single select at 1000 rows.
  const PAGE_SIZE = 1000;
  const artists = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("artists")
      .select(
        `id, name,
         links:artist_links(platform, url),
         bandcamp_albums:artist_bandcamp_albums(bandcamp_id)`
      )
      .eq("directory_status", "approved")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    artists.push(...(page ?? []));
    if (!page || page.length < PAGE_SIZE) break;
  }

  // Filter to artists with a Bandcamp link
  let targets = artists.filter((a) =>
    a.links?.some((l) => l.platform === "bandcamp")
  );

  // Skip artists already enriched (unless --force)
  if (!FORCE) {
    targets = targets.filter(
      (a) => !a.bandcamp_albums || a.bandcamp_albums.length === 0
    );
  }

  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`${targets.length} artist(s) to process\n`);

  let found = 0;
  let notFound = 0;

  for (const artist of targets) {
    const bandcampLink = artist.links.find((l) => l.platform === "bandcamp");
    const artistUrl = bandcampLink.url;

    // Polite delay between requests (skip before the first one)
    if (found + notFound > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    const result = await fetchBandcampPage(artistUrl);

    if (!result) {
      notFound++;
      console.log(`✗ ${artist.name}: could not fetch page (${artistUrl})`);
      continue;
    }

    const { html, resolvedBase } = result;
    const items = parseMusicGrid(html, resolvedBase);

    if (items.length === 0) {
      notFound++;
      console.log(`✗ ${artist.name}: no music-grid items found`);
      continue;
    }

    found++;
    const summary = items
      .slice(0, 3)
      .map((i) => `"${i.title ?? i.bandcamp_id}"`)
      .join(", ");
    console.log(
      `✓ ${artist.name}: ${items.length} item(s) — ${summary}${items.length > 3 ? ", …" : ""}`
    );

    if (!DRY_RUN) {
      const { error: upsertError } = await supabase
        .from("artist_bandcamp_albums")
        .upsert(
          items.map((item) => ({ artist_id: artist.id, ...item })),
          { onConflict: "artist_id,bandcamp_id" }
        );

      if (upsertError) {
        console.error(`  failed to save: ${upsertError.message}`);
      }
    }
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  enriched:  ${found}`);
  console.log(`  not found: ${notFound}`);
}

main().catch((err) => {
  console.error("\nEnrichment failed:", err?.message ?? err);
  process.exit(1);
});
