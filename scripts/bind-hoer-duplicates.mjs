#!/usr/bin/env node
// ============================================================
// Bind pending HÖR imports to the artist they duplicate
//
// A pending artist whose ONLY link is a HÖR link is what a row imported
// from the HÖR library looks like before anyone matches it to a real
// profile. When that same HÖR URL also sits on exactly one other live
// artist, the pending row is that artist under a second id: it is marked
// directory_status='duplicate' with duplicate_of pointing at the other,
// which takes it out of the review queue for good.
//
//   candidate    directory_status='pending', not deleted, and every link
//                row it has is the platform='hoer' one
//   target       any non-deleted artist on the same URL whose status is
//                approved, pending, sc_followee, obscure or rejected
//
//   exactly one target  -> mark the candidate duplicate
//   more than one       -> mark nothing; the case is written to
//                          outputs/hoer-dupe-ambiguous-<stamp>.csv
//   none                -> nothing
//
// obscure and rejected count as targets even though neither shows in the
// public directory: a second pending row for an artist somebody already
// looked at and set aside is still a duplicate, and leaving it unbound
// only puts it back in front of the next reviewer.
//
// Two pending rows sharing a URL each see exactly one other, so they
// would point at each other and neither would survive. The survivor is
// chosen by status (approved > sc_followee > pending > obscure >
// rejected, then oldest id) and only the rest are marked.
//
// Ordering: run this AFTER apply-pending-hoer-decisions, not before. That
// script acts on decisions written by hand in the review sheet, and a
// hand-written decision should win. Running it first leaves nothing here
// to trip over — a row it deleted is gone, and a row it decided is no
// longer 'pending', so neither is a candidate any more.
//
// Dry-run unless --apply is given; --apply writes an audit CSV of every
// row it is about to change first, so each bind can be traced back.
//
// Usage (from rebalance-gender/):
//
//   npm run bind-hoer-duplicates
//   npm run bind-hoer-duplicates -- --apply
//   npx tsx scripts/bind-hoer-duplicates.mjs --apply
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSupabase, loadEnvLocal, makeFetchAll } from "./lib/hoer-db.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

loadEnvLocal();
const supabase = createSupabase();
const fetchAll = makeFetchAll(supabase);

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const normalizeUrl = (u) => (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function writeCsv(file, header, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header.join(",")].concat(rows.map((r) => r.map(esc).join(","))).join("\n") + "\n");
  return path.relative(REPO, file);
}

// Some rows carry the bare https://hoer.live/artist URL with no page slug;
// that is not an identity, so it can never establish a duplicate.
const BARE_URL = "https://hoer.live/artist";

const STATUS_RANK = { approved: 0, sc_followee: 1, pending: 2, obscure: 3, rejected: 4 };
const ELIGIBLE = new Set(Object.keys(STATUS_RANK));
const rankBetter = (x, y) =>
  (STATUS_RANK[x.directory_status] ?? 9) - (STATUS_RANK[y.directory_status] ?? 9) || x.id.localeCompare(y.id);

async function main() {
  const hoerLinks = await fetchAll(
    "artist_links",
    "artist_id, url, not_found, artists(id, name, directory_status, deleted)",
    (q) => q.eq("platform", "hoer")
  );
  console.log(`Loaded ${hoerLinks.length} hoer links from the DB.`);

  const eligibleByUrl = new Map(); // url -> [artist]
  const urlOf = new Map(); // artist_id -> url
  const byId = new Map(); // artist_id -> artist
  for (const l of hoerLinks) {
    const a = l.artists;
    if (!a || a.deleted || l.not_found) continue;
    byId.set(a.id, a);
    const u = normalizeUrl(l.url ?? "");
    if (!u || u === BARE_URL) continue;
    urlOf.set(a.id, u);
    if (!ELIGIBLE.has(a.directory_status)) continue;
    if (!eligibleByUrl.has(u)) eligibleByUrl.set(u, []);
    if (!eligibleByUrl.get(u).some((x) => x.id === a.id)) eligibleByUrl.get(u).push(a);
  }

  // Candidates are the pending rows; "only a HÖR link" needs their other
  // links, which the hoer-only query above cannot show.
  const pendingIds = [...new Set(
    hoerLinks
      .filter((l) => l.artists && !l.artists.deleted && l.artists.directory_status === "pending")
      .map((l) => l.artists.id)
  )];
  const hasOtherLink = new Set();
  for (let i = 0; i < pendingIds.length; i += 200) {
    const { data, error } = await supabase
      .from("artist_links")
      .select("artist_id, platform, not_found")
      .in("artist_id", pendingIds.slice(i, i + 200));
    if (error) throw new Error(`fetch candidate links: ${error.message}`);
    for (const l of data) if (l.platform !== "hoer" && !l.not_found) hasOtherLink.add(l.artist_id);
  }
  const candidates = pendingIds.filter((id) => !hasOtherLink.has(id));
  console.log(`${candidates.length} of ${pendingIds.length} pending artists hold only a HÖR link.`);

  const proposals = new Map(); // artist_id -> target artist
  const ambiguous = [];
  for (const id of candidates) {
    const u = urlOf.get(id);
    if (!u) continue;
    const others = (eligibleByUrl.get(u) ?? []).filter((o) => o.id !== id);
    if (others.length === 0) continue;
    if (others.length === 1) proposals.set(id, others[0]);
    else ambiguous.push({ artist: byId.get(id), url: u, others });
  }

  // Two pending rows on one URL each nominate the other; keep the better-
  // ranked one so the pair does not annihilate itself.
  let cyclesBroken = 0;
  for (const group of eligibleByUrl.values()) {
    const proposers = group.filter((g) => proposals.has(g.id));
    if (proposers.length < 2) continue;
    const survivor = [...group].sort(rankBetter)[0];
    for (const p of proposers) {
      if (p.id === survivor.id) proposals.delete(p.id);
      else proposals.set(p.id, survivor);
    }
    cyclesBroken++;
  }
  if (cyclesBroken) console.log(`  mutual proposals resolved by survivor rank: ${cyclesBroken}`);

  // A target that is itself being marked would leave duplicate_of pointing
  // at a duplicate. The cycle pass above should make this impossible; if it
  // ever fires, the chain is a bug worth seeing rather than writing.
  const chained = [...proposals].filter(([, t]) => proposals.has(t.id));
  if (chained.length) {
    for (const [id, t] of chained.slice(0, 10))
      console.log(`  CHAIN: ${id} -> ${t.id}, which is itself being marked duplicate`);
    throw new Error(`${chained.length} proposed binds point at another proposed duplicate — not applying.`);
  }

  const targetStatus = {};
  for (const t of proposals.values())
    targetStatus[t.directory_status] = (targetStatus[t.directory_status] ?? 0) + 1;
  console.log(`\nTo bind as duplicates: ${proposals.size}`);
  if (proposals.size) console.log(`  target status: ${JSON.stringify(targetStatus)}`);
  console.log(`Ambiguous (more than one candidate): ${ambiguous.length}`);

  if (ambiguous.length) {
    const rel = writeCsv(
      path.join(REPO, "outputs", `hoer-dupe-ambiguous-${stamp}.csv`),
      ["artist_id", "name", "hoer_url", "candidate_count", "candidates"],
      ambiguous.map((r) => [
        r.artist?.id ?? "",
        r.artist?.name ?? "",
        r.url,
        r.others.length,
        r.others.map((o) => `${o.id} "${o.name}" [${o.directory_status}]`).join(" | "),
      ])
    );
    console.log(`  written to ${rel}`);
  }

  if (!proposals.size) {
    console.log("\nNothing to bind.");
    return;
  }

  // Confirm every target is still there and still not soft-deleted; the
  // index was built from the same fetch, so this is a cheap re-read that
  // catches a target removed between runs.
  const targetIds = [...new Set([...proposals.values()].map((t) => t.id))];
  const live = new Map();
  for (let i = 0; i < targetIds.length; i += 100) {
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, directory_status, deleted")
      .in("id", targetIds.slice(i, i + 100));
    if (error) throw new Error(`fetch targets: ${error.message}`);
    for (const a of data) live.set(a.id, a);
  }
  for (const id of targetIds) {
    const info = live.get(id);
    if (!info) throw new Error(`Duplicate target ${id} not found in the DB.`);
    if (info.deleted) throw new Error(`Duplicate target ${id} ("${info.name}") is soft-deleted.`);
  }

  if (!APPLY) {
    console.log("\nDry run only — re-run with --apply to execute.");
    return;
  }

  const rel = writeCsv(
    path.join(REPO, "outputs", `bind-hoer-duplicates-${stamp}.csv`),
    ["artist_id", "name", "hoer_url", "prior_status", "duplicate_of", "target_name", "target_status"],
    [...proposals].map(([id, t]) => [
      id,
      byId.get(id)?.name ?? "",
      urlOf.get(id) ?? "",
      byId.get(id)?.directory_status ?? "",
      t.id,
      t.name,
      t.directory_status,
    ])
  );
  console.log(`\nAudit written to ${rel}`);
  console.log("Applying…");

  let done = 0;
  for (const [id, t] of proposals) {
    const { error } = await supabase
      .from("artists")
      .update({ directory_status: "duplicate", duplicate_of: t.id })
      .eq("id", id);
    if (error) throw new Error(`bind ${id}: ${error.message}`);
    if (++done % 100 === 0) console.log(`  ${done}/${proposals.size} bound`);
  }
  console.log(`  duplicate marks: ${done} done`);
  console.log("\nAll done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
