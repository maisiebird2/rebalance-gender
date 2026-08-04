#!/usr/bin/env node
// ============================================================
// Export sc_followee artists who have a HÖR link, as an ODS spreadsheet
//
// One row per artist with directory_status = 'sc_followee' AND a
// platform='hoer' row in artist_links. Columns:
//
//   Artist              — name, hyperlinked to /artist/<id> on the site
//   artist_id           — the UUID
//   SoundCloud followers — artist_enrichment.follower_count for
//                          platform='soundcloud' (blank if never enriched)
//
// The artist hyperlinks only resolve for a signed-in admin: /artist/<id>
// 404s for non-approved artists otherwise, and sc_followee is by
// definition not approved.
//
// not_found hoer rows are excluded by default — those record "we looked
// and there is no HÖR page", not a link. Pass --include-not-found to
// count them anyway.
//
// This script is read-only against the database.
//
// Usage (from rebalance-gender/):
//
//   npm run export-hoer-sc-followees
//   npm run export-hoer-sc-followees -- --sort=name
//   npm run export-hoer-sc-followees -- --out=outputs/my-sheet.ods
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
// and NEXT_PUBLIC_SITE_URL for the artist-page hyperlinks).
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import fs from "node:fs";
import path from "node:path";
import { createSupabase, loadEnvLocal, makeFetchAll } from "./lib/hoer-db.mjs";
import { buildOds } from "../src/lib/ods.ts";

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const SORT = argValue("sort", "followers");
const INCLUDE_NOT_FOUND = args.includes("--include-not-found");

if (!["followers", "name"].includes(SORT)) {
  console.error(`--sort must be "followers" or "name" (got "${SORT}").`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const OUT = argValue("out", path.join("outputs", `hoer-sc-followees-${stamp}.ods`));

loadEnvLocal();
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.rebalance-gender.app").replace(/\/+$/, "");
const supabase = createSupabase();
const fetchAll = makeFetchAll(supabase);

// ── Main ────────────────────────────────────────────────────
async function main() {
  // !inner on artist_links makes the platform='hoer' filter a join
  // condition, so only artists carrying a HÖR link come back.
  // artist_enrichment stays a left join — an sc_followee that was never
  // enriched should still appear, just without a follower count.
  const rows = await fetchAll(
    "artists",
    "id, name, artist_links!inner(platform, not_found), artist_enrichment(platform, follower_count)",
    (q) => {
      let query = q
        .eq("directory_status", "sc_followee")
        .eq("deleted", false)
        .eq("artist_links.platform", "hoer")
        .eq("artist_enrichment.platform", "soundcloud");
      if (!INCLUDE_NOT_FOUND) query = query.eq("artist_links.not_found", false);
      return query;
    }
  );

  const artists = rows.map((a) => ({
    id: a.id,
    name: a.name,
    followers: a.artist_enrichment?.[0]?.follower_count ?? null,
  }));

  artists.sort((x, y) =>
    SORT === "name"
      ? x.name.localeCompare(y.name)
      : // Followers descending, unknown counts last, name as the tiebreak.
        (y.followers ?? -1) - (x.followers ?? -1) || x.name.localeCompare(y.name)
  );

  const ods = buildOds({
    name: "HÖR sc_followees",
    headers: ["Artist", "artist_id", "SoundCloud followers"],
    rows: artists.map((a) => [
      { href: `${SITE_URL}/artist/${a.id}`, text: a.name },
      a.id,
      a.followers,
    ]),
  });

  const abs = path.resolve(OUT);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, ods);

  const missing = artists.filter((a) => a.followers === null).length;
  console.log(`sc_followee artists with a HÖR link: ${artists.length}`);
  console.log(`  without a SoundCloud follower count: ${missing}`);
  console.log(`\nWrote ${abs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
