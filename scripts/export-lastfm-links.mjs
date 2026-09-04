#!/usr/bin/env node
// ============================================================
// Export every artist carrying a Last.fm link, as an ODS spreadsheet
//
// One row per artist with a platform='lastfm' row in artist_links.
// Columns:
//
//   Artist          — name, hyperlinked to /artist/<id> on the site
//   artist_id       — the UUID
//   Status          — directory_status, raw (approved, sc_followee, …)
//   Last.fm name    — the artist name as it appears in the URL path,
//                     percent-decoded (…/music/Acida%20Dominga →
//                     "Acida Dominga")
//   Last.fm URL     — the stored URL, hyperlinked to itself
//
// No directory_status filter — every status is included, so most of
// these hyperlinks only resolve for a signed-in admin (/artist/<id>
// 404s for anything not approved). Soft-deleted artists ARE excluded.
//
// not_found lastfm rows are excluded by default — those record "we
// looked and there is no Last.fm page", not a link. Pass
// --include-not-found to list them too (their URL may be blank).
//
// This script is read-only against the database.
//
// Usage (from rebalance-gender/):
//
//   npm run export-lastfm-links
//   npm run export-lastfm-links -- --include-not-found
//   npm run export-lastfm-links -- --out=my-sheet.ods
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
// and NEXT_PUBLIC_SITE_URL for the artist-page hyperlinks).
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import fs from "node:fs";
import { createSupabase, loadEnvLocal, makeFetchAll } from "./lib/hoer-db.mjs";
import { buildOds } from "../src/lib/ods.ts";
import { outputPath } from "./lib/output-path.mjs";
import { siteUrl } from "./lib/site-url.mjs";

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const INCLUDE_NOT_FOUND = args.includes("--include-not-found");

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const OUT = argValue("out", `lastfm-links-${stamp}.ods`);

loadEnvLocal();
const SITE_URL = siteUrl();
const supabase = createSupabase();
const fetchAll = makeFetchAll(supabase);

/**
 * Pull the artist segment out of a Last.fm URL and decode it.
 *
 * Shapes seen in the table: /music/Acida%20Dominga, /music/Four+Tet
 * (Last.fm writes spaces both ways), a locale prefix on some rows
 * (/es/music/…), and trailing subpages (/music/Aphex+Twin/+wiki).
 * Returns null for anything that isn't a /music/<name> URL.
 */
function lastfmName(url) {
  if (!url) return null;
  // Matched against the raw string rather than new URL().pathname: the WHATWG
  // parser resolves dot segments away, and several artists here really are
  // named "." or ".." (…/music/. would come back empty).
  const match = /^(?:https?:\/\/)?[^/]+\/(?:[a-z]{2}\/)?music\/([^/?#]+)/i.exec(url.trim());
  if (!match) return null;
  // "+" is a space in a Last.fm path; decodeURIComponent leaves it alone.
  const raw = match[1].replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent-escape — show the raw segment rather than dropping it.
    return raw;
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  // !inner on artist_links makes the platform='lastfm' filter a join
  // condition, so only artists carrying a Last.fm link come back.
  const rows = await fetchAll(
    "artists",
    "id, name, directory_status, artist_links!inner(platform, url, not_found)",
    (q) => {
      let query = q
        .eq("deleted", false)
        .eq("artist_links.platform", "lastfm");
      if (!INCLUDE_NOT_FOUND) query = query.eq("artist_links.not_found", false);
      return query;
    }
  );

  const artists = rows
    .map((a) => {
      const url = a.artist_links?.[0]?.url ?? null;
      return {
        id: a.id,
        name: a.name,
        status: a.directory_status,
        url,
        lastfm: lastfmName(url),
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  const ods = buildOds({
    name: "Last.fm links",
    headers: ["Artist", "artist_id", "Status", "Last.fm name", "Last.fm URL"],
    rows: artists.map((a) => [
      { href: `${SITE_URL}/artist/${a.id}`, text: a.name },
      a.id,
      a.status,
      a.lastfm,
      a.url ? { href: a.url, text: a.url } : null,
    ]),
  });

  const abs = outputPath(OUT);
  fs.writeFileSync(abs, ods);

  const unparsed = artists.filter((a) => a.url && !a.lastfm).length;
  console.log(`Artists with a Last.fm link: ${artists.length}`);
  const byStatus = new Map();
  for (const a of artists) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  for (const [status, count] of [...byStatus].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${status}: ${count}`);
  }
  if (unparsed) console.log(`  URLs with no /music/<name> segment: ${unparsed}`);
  console.log(`\nWrote ${abs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
