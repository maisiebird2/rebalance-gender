#!/usr/bin/env node
// ============================================================
// Export pending artists who have a HÖR link, as an ODS spreadsheet
//
// Regenerates the review sheet that produced
// outputs/pending-hoer-artists-20260726.ods (built by hand in an earlier
// session; this script is the committed version of that recipe).
//
// One row per artist with directory_status = 'pending' AND a
// platform='hoer' row in artist_links. Columns:
//
//   Artist       — name, hyperlinked to /artist/<id> on the site
//   artist_id    — the UUID (what apply-pending-hoer-decisions matches on
//                  when the HÖR link is ambiguous)
//   HÖR link     — the stored URL, hyperlinked to itself
//   decision     — blank, unless --check-links pre-fills "hard delete"
//   duplicate of — always blank; filled in by the reviewer
//   notes        — always blank; filled in by the reviewer
//
// The artist hyperlinks only resolve for a signed-in admin: /artist/<id>
// 404s for non-approved artists, and pending is by definition not approved.
//
// Dead-page detection is OPT-IN, via --check-links. It is by far the slow
// part: hoer-http throttles every caller to 300ms, so a full pass costs
// roughly (rows x 0.3s) — minutes, where the rest of the export takes
// seconds. Most runs only want the current queue as a sheet, so the
// default skips it and leaves the decision column blank.
//
// How it detects one (verified 2026-07-26, re-verified 2026-08-04):
// hoer.live answers a dead artist page with a 302 whose *relative*
// Location is /404/, which lands on /contest_entry/404-lxpanda/. A couple
// of pages answer a plain 404 instead, so both are treated as dead. HEAD
// requests lie — they return 200 for dead pages — so this must be a GET.
//
// not_found hoer rows are excluded by default — those record "we looked
// and there is no HÖR page", not a link. Pass --include-not-found to keep
// them.
//
// This script is read-only against the database.
//
// Usage (from rebalance-gender/):
//
//   npm run export-pending-hoer-artists
//   npm run export-pending-hoer-artists -- --check-links
//   npm run export-pending-hoer-artists -- --sort=name
//   npm run export-pending-hoer-artists -- --out=outputs/my-sheet.ods
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
import { hoerFetch } from "./lib/hoer-http.mjs";
import { buildOds } from "../src/lib/ods.ts";

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const SORT = argValue("sort", "name");
const INCLUDE_NOT_FOUND = args.includes("--include-not-found");
const CHECK_LINKS = args.includes("--check-links");

if (!["name", "status"].includes(SORT)) {
  console.error(`--sort must be "name" or "status" (got "${SORT}").`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const OUT = argValue("out", path.join("outputs", `pending-hoer-artists-${stamp}.ods`));

loadEnvLocal();
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.rebalance-gender.app").replace(/\/+$/, "");
const supabase = createSupabase();
const fetchAll = makeFetchAll(supabase);

// A dead HÖR page either answers 404 outright or redirects off /artist/
// into the site's 404 handler (today that lands on
// /contest_entry/404-lxpanda/, but the rule doesn't depend on that slug —
// any redirect away from an artist page means the page is gone). A
// redirect that stays under /artist/ is a slug change, not a dead page, so
// it counts as live. Anything else — including a network fault — is
// treated as live too, so a flaky probe never proposes a delete.
async function isDeadPage(url) {
  try {
    const res = await hoerFetch(url);
    if (res.status === 404) return true;
    if (!res.ok) return false;
    return res.redirected && !new URL(res.url).pathname.startsWith("/artist/");
  } catch {
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  // !inner on artist_links makes the platform='hoer' filter a join
  // condition, so only artists carrying a HÖR link come back.
  const rows = await fetchAll(
    "artists",
    "id, name, directory_status, artist_links!inner(platform, not_found, url)",
    (q) => {
      let query = q
        .eq("directory_status", "pending")
        .eq("deleted", false)
        .eq("artist_links.platform", "hoer");
      if (!INCLUDE_NOT_FOUND) query = query.eq("artist_links.not_found", false);
      return query;
    }
  );

  const artists = rows.map((a) => ({
    id: a.id,
    name: a.name,
    // Pending artists carry one hoer link each today; if that ever stops
    // being true the first one wins and the rest are reported below.
    url: a.artist_links[0]?.url ?? "",
    extraLinks: a.artist_links.length - 1,
  }));

  artists.sort((x, y) => x.name.localeCompare(y.name));

  console.log(`pending artists with a HÖR link: ${artists.length}`);
  const multi = artists.filter((a) => a.extraLinks > 0);
  if (multi.length) {
    console.log(`  NOTE — ${multi.length} carry more than one hoer link; the first is used:`);
    for (const a of multi.slice(0, 10)) console.log(`    ${a.id} "${a.name}"`);
  }

  const dead = new Set();
  if (CHECK_LINKS) {
    const withUrl = artists.filter((a) => a.url);
    const mins = Math.ceil((withUrl.length * 0.3) / 60);
    console.log(`\nProbing ${withUrl.length} HÖR pages for dead links (~${mins} min at the 300ms throttle)…`);
    let done = 0;
    for (const a of withUrl) {
      if (await isDeadPage(a.url)) dead.add(a.id);
      if (++done % 100 === 0) console.log(`  ${done}/${withUrl.length} probed, ${dead.size} dead so far`);
    }
    console.log(`  probe complete: ${dead.size} dead, ${withUrl.length - dead.size} live`);
  } else {
    console.log("\nNo dead-link probe (pass --check-links to run one); decision column left blank.");
  }

  const ods = buildOds({
    name: "Pending HÖR artists",
    headers: ["Artist", "artist_id", "HÖR link", "decision", "duplicate of", "notes"],
    rows: artists.map((a) => [
      { href: `${SITE_URL}/artist/${a.id}`, text: a.name },
      a.id,
      a.url ? { href: a.url, text: a.url } : "",
      dead.has(a.id) ? "hard delete" : "",
      "",
      "",
    ]),
  });

  const abs = path.resolve(OUT);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, ods);
  console.log(`\nWrote ${abs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
