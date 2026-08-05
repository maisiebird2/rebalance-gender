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
//   decision     — pre-filled "hard delete" for a dead HÖR page, else blank
//   duplicate of — always blank; filled in by the reviewer
//   notes        — always blank; filled in by the reviewer
//
// The artist hyperlinks only resolve for a signed-in admin: /artist/<id>
// 404s for non-approved artists, and pending is by definition not approved.
//
// ── Two clean-up passes run before the sheet is written ─────
//
// 1. DUPLICATE BINDING. Every pending artist here holds a HÖR link and
//    nothing else, which is what a row imported from the HÖR library looks
//    like before anyone matches it to a real profile. When that same HÖR
//    URL also sits on exactly one other approved / pending / sc_followee
//    artist, the pending row is that artist under a second id: it is marked
//    directory_status='duplicate' with duplicate_of pointing at the other,
//    and dropped from the sheet. When the URL turns up more than one other
//    eligible artist, nothing is marked — the case goes to
//    outputs/hoer-dupe-ambiguous-<stamp>.csv for a human.
//
//    Two pending rows sharing a URL each see exactly one other, so they
//    would point at each other; the survivor is chosen by status
//    (approved > sc_followee > pending, then oldest id) and only the rest
//    are marked.
//
// 2. HARD DELETE FROM A REVIEWED SHEET. With --decisions=<sheet.ods>, rows
//    whose decision reads "empty page" or "hard delete" are deleted
//    outright, so they stop coming back in later exports. Only artists that
//    are still pending and not soft-deleted are touched — a stale sheet
//    can never reach an artist somebody has since approved. Note this is a
//    HARD delete for "empty page" too, where apply-pending-hoer-decisions
//    soft-deletes it.
//
// Both passes are dry-run unless --apply is given, and --apply writes an
// audit CSV of every row it is about to change first.
//
// ── Dead-link detection ─────────────────────────────────────
//
// Verified 2026-07-26, re-verified 2026-08-04: hoer.live answers a dead
// artist page with a 302 whose *relative* Location is /404/, which lands
// on /contest_entry/404-lxpanda/. A couple of pages answer a plain 404
// instead, so both count as dead. HEAD requests lie — they return 200 for
// dead pages — so this must be a GET.
//
// Probing runs by default and is the slow part: hoer-http throttles every
// caller to 300ms, so expect roughly (rows x 0.3s). Pass --no-check-links
// to skip it and emit a blank decision column instead.
//
// not_found hoer rows are excluded by default — those record "we looked
// and there is no HÖR page", not a link. Pass --include-not-found to keep
// them.
//
// Usage (from rebalance-gender/):
//
//   npm run export-pending-hoer-artists
//   npm run export-pending-hoer-artists -- --apply
//   npm run export-pending-hoer-artists -- --decisions=../sheet_MOD.ods --apply
//   npm run export-pending-hoer-artists -- --no-check-links
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
import { readOdsRows } from "./lib/ods-read.mjs";
import { buildOds } from "../src/lib/ods.ts";

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const SORT = argValue("sort", "name");
const INCLUDE_NOT_FOUND = args.includes("--include-not-found");
const CHECK_LINKS = !args.includes("--no-check-links");
const APPLY = args.includes("--apply");
const DECISIONS = argValue("decisions", null);

if (!["name", "status"].includes(SORT)) {
  console.error(`--sort must be "name" or "status" (got "${SORT}").`);
  process.exit(1);
}
if (DECISIONS && !fs.existsSync(DECISIONS)) {
  console.error(`--decisions sheet not found: ${path.resolve(DECISIONS)}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const OUT = argValue("out", path.join("outputs", `pending-hoer-artists-${stamp}.ods`));

loadEnvLocal();
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.rebalance-gender.app").replace(/\/+$/, "");
const supabase = createSupabase();
const fetchAll = makeFetchAll(supabase);

const normalizeUrl = (u) => (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
const csvEscape = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function writeCsv(file, header, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header.join(",")].concat(rows.map((r) => r.map(csvEscape).join(","))).join("\n") + "\n");
}

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

// Survivor preference when a HÖR URL is shared: an approved artist outranks
// an sc_followee, which outranks another pending row; ties break on the id
// so the choice is stable between runs.
const STATUS_RANK = { approved: 0, sc_followee: 1, pending: 2 };
const ELIGIBLE = new Set(Object.keys(STATUS_RANK));
const better = (x, y) =>
  (STATUS_RANK[x.directory_status] ?? 9) - (STATUS_RANK[y.directory_status] ?? 9) || x.id.localeCompare(y.id);

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
  const byId = new Map(artists.map((a) => [a.id, a]));

  console.log(`pending artists with a HÖR link: ${artists.length}`);
  const multi = artists.filter((a) => a.extraLinks > 0);
  if (multi.length) {
    console.log(`  NOTE — ${multi.length} carry more than one hoer link; the first is used:`);
    for (const a of multi.slice(0, 10)) console.log(`    ${a.id} "${a.name}"`);
  }

  // Which of them hold a HÖR link and nothing else. Fetched separately
  // because the query above only returns the hoer rows it joined on.
  const ids = artists.map((a) => a.id);
  const linkCount = new Map(); // artist_id -> count of non-hoer live links
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("artist_links")
      .select("artist_id, platform, not_found")
      .in("artist_id", ids.slice(i, i + 200));
    if (error) throw new Error(`fetch links: ${error.message}`);
    for (const l of data) {
      if (l.platform === "hoer" || l.not_found) continue;
      linkCount.set(l.artist_id, (linkCount.get(l.artist_id) ?? 0) + 1);
    }
  }
  const onlyHoer = artists.filter((a) => !linkCount.has(a.id));
  console.log(`  of those, whose only link is the HÖR one: ${onlyHoer.length}`);

  // ── Pass 1: duplicate binding ─────────────────────────────
  // Index every hoer link in the DB by URL so a pending row can be checked
  // against the artists that already hold the same page.
  const hoerLinks = await fetchAll(
    "artist_links",
    "artist_id, url, not_found, artists(id, name, directory_status, deleted)",
    (q) => q.eq("platform", "hoer")
  );
  const byUrl = new Map();
  for (const l of hoerLinks) {
    const a = l.artists;
    if (!a || a.deleted || l.not_found) continue;
    const u = normalizeUrl(l.url);
    if (!u) continue;
    if (!byUrl.has(u)) byUrl.set(u, []);
    if (!byUrl.get(u).some((x) => x.id === a.id)) byUrl.get(u).push(a);
  }
  console.log(`\nIndexed ${byUrl.size} distinct HÖR URLs across ${hoerLinks.length} link rows.`);

  const proposals = new Map(); // artist_id -> target artist row
  const ambiguous = [];
  for (const a of onlyHoer) {
    const u = normalizeUrl(a.url);
    if (!u) continue;
    const others = (byUrl.get(u) ?? []).filter((o) => o.id !== a.id && ELIGIBLE.has(o.directory_status));
    if (others.length === 0) continue;
    if (others.length === 1) proposals.set(a.id, others[0]);
    else ambiguous.push({ artist: a, others });
  }

  // Two pending rows on one URL each nominate the other. Keep the better-
  // ranked of the pair and mark only the loser, so no pair ends up with
  // both sides marked duplicate and neither surviving.
  let cyclesBroken = 0;
  for (const [url, group] of byUrl) {
    const proposers = group.filter((g) => proposals.has(g.id));
    if (proposers.length < 2) continue;
    const survivor = group.filter((g) => ELIGIBLE.has(g.directory_status)).sort(better)[0];
    if (!survivor) continue;
    for (const p of proposers) {
      if (p.id === survivor.id) proposals.delete(p.id);
      else proposals.set(p.id, survivor);
    }
    cyclesBroken++;
    if (cyclesBroken <= 5) console.log(`  cycle on ${url}: keeping ${survivor.id} [${survivor.directory_status}]`);
  }
  if (cyclesBroken) console.log(`  mutual proposals resolved: ${cyclesBroken}`);

  console.log(`\nDuplicate binding:`);
  console.log(`  to mark duplicate: ${proposals.size}`);
  console.log(`  ambiguous (more than one candidate): ${ambiguous.length}`);
  const targetStatus = {};
  for (const t of proposals.values())
    targetStatus[t.directory_status] = (targetStatus[t.directory_status] ?? 0) + 1;
  if (proposals.size) console.log(`  target status: ${JSON.stringify(targetStatus)}`);

  let ambiguousPath = null;
  if (ambiguous.length) {
    ambiguousPath = path.join("outputs", `hoer-dupe-ambiguous-${stamp}.csv`);
    writeCsv(
      ambiguousPath,
      ["artist_id", "name", "hoer_url", "candidate_count", "candidates"],
      ambiguous.map((r) => [
        r.artist.id,
        r.artist.name,
        r.artist.url,
        r.others.length,
        r.others.map((o) => `${o.id} "${o.name}" [${o.directory_status}]`).join(" | "),
      ])
    );
    console.log(`  ambiguous cases written to ${ambiguousPath}`);
  }

  // ── Pass 2: hard deletes from a reviewed sheet ────────────
  const toDelete = new Map(); // artist_id -> { id, name, decision }
  const deleteProblems = [];
  let deleteAlreadyGone = 0;
  if (DECISIONS) {
    const sheet = readOdsRows(DECISIONS, { sheet: "Pending HÖR artists" });
    const DELETE_DECISIONS = new Set(["empty page", "hard delete"]);
    const marked = sheet.filter((r) => DELETE_DECISIONS.has((r["decision"] ?? "").trim().toLowerCase()));
    console.log(`\nReviewed sheet ${path.basename(DECISIONS)}: ${sheet.length} rows, ${marked.length} marked for deletion.`);

    // Rows are matched by artist_id when the sheet carries one (sheets this
    // script writes do), otherwise by HÖR URL. Only artists that are still
    // pending and not soft-deleted are eligible, so a stale sheet cannot
    // reach anything that has since been approved or resolved.
    const pendingByUrl = new Map();
    for (const a of artists) {
      const u = normalizeUrl(a.url);
      if (!u) continue;
      if (!pendingByUrl.has(u)) pendingByUrl.set(u, []);
      pendingByUrl.get(u).push(a);
    }
    for (const r of marked) {
      const decision = (r["decision"] ?? "").trim().toLowerCase();
      const name = (r["Artist"] ?? "").trim();
      const rawId = (r["artist_id"] ?? "").trim().toLowerCase();
      if (rawId) {
        const hit = byId.get(rawId);
        if (hit) toDelete.set(hit.id, { ...hit, decision });
        else deleteAlreadyGone++;
        continue;
      }
      const u = normalizeUrl(r["HÖR link"] ?? "");
      const hits = u ? pendingByUrl.get(u) ?? [] : [];
      if (hits.length === 1) toDelete.set(hits[0].id, { ...hits[0], decision });
      else if (hits.length === 0) deleteAlreadyGone++;
      else deleteProblems.push(`AMBIGUOUS delete for "${name}" (${u}): ${hits.map((h) => h.id).join(", ")}`);
    }
    console.log(`  resolved to live pending artists: ${toDelete.size}`);
    console.log(`  no longer pending / already gone (skipped): ${deleteAlreadyGone}`);
    for (const p of deleteProblems) console.log(`  ${p}`);
  }

  // Deletion wins over a duplicate mark, in both directions: marking a row
  // duplicate of an artist this run deletes would leave duplicate_of
  // dangling, and marking a row that is itself about to be deleted is
  // wasted work. Either way the row leaves the sheet.
  const targetDeleted = [...proposals].filter(([, t]) => toDelete.has(t.id));
  for (const [id] of targetDeleted) proposals.delete(id);
  if (targetDeleted.length)
    console.log(`\n  ${targetDeleted.length} duplicate marks dropped: their target is being deleted this run.`);

  const selfDeleted = [...proposals.keys()].filter((id) => toDelete.has(id));
  for (const id of selfDeleted) proposals.delete(id);
  if (selfDeleted.length)
    console.log(`  ${selfDeleted.length} duplicate marks dropped: the artist is being deleted this run.`);

  // ── Writes ────────────────────────────────────────────────
  const dupList = [...proposals].map(([id, t]) => ({ artist: byId.get(id), target: t }));
  const delList = [...toDelete.values()];

  if (APPLY && (dupList.length || delList.length)) {
    const auditPath = path.join("outputs", `export-pending-hoer-changes-${stamp}.csv`);
    writeCsv(
      auditPath,
      ["action", "artist_id", "name", "hoer_url", "prior_status", "duplicate_of", "target_name", "decision"],
      [
        ...dupList.map((d) => [
          "duplicate", d.artist.id, d.artist.name, d.artist.url, "pending", d.target.id, d.target.name, "",
        ]),
        ...delList.map((d) => ["hard_delete", d.id, d.name, d.url, "pending", "", "", d.decision]),
      ]
    );
    console.log(`\nAudit written to ${auditPath}`);
    console.log("Applying…");

    for (const d of dupList) {
      const { error } = await supabase
        .from("artists")
        .update({ directory_status: "duplicate", duplicate_of: d.target.id })
        .eq("id", d.artist.id);
      if (error) throw new Error(`dup mark ${d.artist.id}: ${error.message}`);
    }
    console.log(`  duplicate marks: ${dupList.length} done`);

    if (delList.length) {
      // hoer_terms' FK is ON DELETE SET NULL, but the
      // hoer_terms_bound_consistency constraint requires artist_id,
      // bind_method and bound_at to be null together — fully unbind the
      // terms first so the artist delete can proceed.
      const delIds = delList.map((d) => d.id);
      for (let i = 0; i < delIds.length; i += 100) {
        const { error } = await supabase
          .from("hoer_terms")
          .update({ artist_id: null, bind_method: null, bound_at: null })
          .in("artist_id", delIds.slice(i, i + 100));
        if (error) throw new Error(`unbind hoer_terms: ${error.message}`);
      }
      let deleted = 0;
      for (let i = 0; i < delIds.length; i += 50) {
        const { data, error } = await supabase
          .from("artists")
          .delete()
          .in("id", delIds.slice(i, i + 50))
          .select("id");
        if (error) throw new Error(`hard delete: ${error.message}`);
        deleted += data.length;
      }
      console.log(`  hard deleted: ${deleted} artists`);
    }
  } else if (dupList.length || delList.length) {
    console.log(`\nDry run — no writes. Re-run with --apply to mark ${dupList.length} duplicate(s) and delete ${delList.length} artist(s).`);
  }

  // ── Sheet ─────────────────────────────────────────────────
  // Duplicates and deletions come out of the sheet whether or not --apply
  // ran, so a dry run previews exactly the sheet --apply would produce.
  const excluded = new Set([...proposals.keys(), ...toDelete.keys()]);
  const remaining = artists.filter((a) => !excluded.has(a.id));
  console.log(`\nSheet rows: ${remaining.length} (${artists.length} pending - ${excluded.size} duplicate/deleted)`);

  const dead = new Set();
  if (CHECK_LINKS) {
    const withUrl = remaining.filter((a) => a.url);
    const mins = Math.ceil((withUrl.length * 0.3) / 60);
    console.log(`\nProbing ${withUrl.length} HÖR pages for dead links (~${mins} min at the 300ms throttle)…`);
    let done = 0;
    for (const a of withUrl) {
      if (await isDeadPage(a.url)) dead.add(a.id);
      if (++done % 100 === 0) console.log(`  ${done}/${withUrl.length} probed, ${dead.size} dead so far`);
    }
    console.log(`  probe complete: ${dead.size} dead, ${withUrl.length - dead.size} live`);
  } else {
    console.log("\nSkipping the dead-link probe (--no-check-links); decision column left blank.");
  }

  const ods = buildOds({
    name: "Pending HÖR artists",
    headers: ["Artist", "artist_id", "HÖR link", "decision", "duplicate of", "notes"],
    rows: remaining.map((a) => [
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
  if (ambiguousPath) console.log(`Ambiguous duplicate cases: ${ambiguousPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
