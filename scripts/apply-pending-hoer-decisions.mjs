#!/usr/bin/env node
// Applies the manual review decisions in "pending-hoer-artists-20260726_MOD.ods"
// (one level above the repo) to the artists table.
//
// Reads the sheet named "Pending HÖR artists" (errors if it is missing).
// Sheet columns: Artist | HÖR link | decision | duplicate of | notes
//
//   empty page        -> soft delete (deleted = true)
//   not eligible      -> directory_status = 'not_eligible'
//   duplicate         -> directory_status = 'duplicate',
//                        duplicate_of = "duplicate of" column (an artist UUID)
//   yes               -> directory_status = 'approved'
//   dead link         -> hard-delete artist row
//   hard delete       -> hard-delete artist row
//   special case      -> no action
//   manually handled  -> no action
//   (empty)           -> no action
//
// Any other decision value is skipped and listed in the output for review.
//
// Rows are matched to artists through their platform='hoer' artist_links URL.
// Duplicate-resolution copies the hoer link onto survivors, so one URL can sit
// on several artists; a status='pending' match wins in that case. The two
// "dead link" rows carry the bare https://hoer.live/artist/ URL (no slug) and
// are matched by exact artist name instead.
//
// Usage: node scripts/apply-pending-hoer-decisions.mjs [--apply] [path/to.ods]
//        (default is dry-run/verify; default sheet is the file named above)

import "./lib/http-dispatcher.mjs";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const ODS =
  process.argv.slice(2).find((a) => a !== "--apply") ??
  path.join(REPO, "..", "pending-hoer-artists-20260726_MOD.ods");

for (const line of fs.readFileSync(path.join(REPO, ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const key = t.slice(0, eq).trim();
  let value = t.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    value = value.slice(1, -1);
  if (!(key in process.env)) process.env[key] = value;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

// --- minimal ODS reader: unzip content.xml, walk rows/cells of sheet 1 ---
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

const SHEET_NAME = "Pending HÖR artists";

function readOdsRows(odsPath) {
  const xml = execFileSync("unzip", ["-p", odsPath, "content.xml"], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const sheets = new Map(); // name -> inner xml
  for (const m of xml.matchAll(/<table:table ([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = m[1].match(/table:name="([^"]*)"/)?.[1];
    if (name != null) sheets.set(unescapeXml(name), m[2]);
  }
  const sheetXml = sheets.get(SHEET_NAME);
  if (sheetXml == null)
    throw new Error(
      `Sheet "${SHEET_NAME}" not found in ${path.basename(odsPath)} — ` +
        `sheets present: ${[...sheets.keys()].map((n) => `"${n}"`).join(", ") || "(none)"}`
    );
  const rows = [];
  for (const rowXml of sheetXml.matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
    const cells = [];
    for (const cellXml of rowXml[1].matchAll(
      /<table:table-cell([^>]*)\/>|<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>/g
    )) {
      const attrs = cellXml[1] ?? cellXml[2] ?? "";
      const body = cellXml[3] ?? "";
      const rep = Number(attrs.match(/table:number-columns-repeated="(\d+)"/)?.[1] ?? "1");
      const paras = [...body.matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g)].map((p) =>
        unescapeXml(p[1].replace(/<[^>]+>/g, ""))
      );
      const value = paras.join("\n").trim();
      for (let i = 0; i < Math.min(rep, 200); i++) cells.push(value);
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length) rows.push(cells);
  }
  const [header, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

const rows = readOdsRows(ODS);
console.log(`Read ${rows.length} data rows from ${path.basename(ODS)}.`);

// --- classify decisions ---
const NOOP_DECISIONS = new Set(["", "special case", "manually handled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_URL = "https://hoer.live/artist";

// "duplicate of" is either a bare artist UUID or a directory profile URL like
// https://www.rebalance-gender.app/artist/<uuid> — accept both.
function parseDupOf(raw) {
  const v = raw.trim().replace(/\/+$/, "");
  if (UUID_RE.test(v)) return v.toLowerCase();
  const tail = v.split("/").pop() ?? "";
  return UUID_RE.test(tail) ? tail.toLowerCase() : null;
}

const normalizeUrl = (u) => u.trim().replace(/\/+$/, "");

// action: soft_delete | not_eligible | duplicate | approve | hard_delete
const actionRows = [];
const unknownDecisions = new Map(); // decision -> [artist names]
let noopCount = 0;

for (const r of rows) {
  const decision = (r["decision"] ?? "").trim();
  const name = (r["Artist"] ?? "").trim();
  const url = normalizeUrl(r["HÖR link"] ?? "");
  const dupOf = parseDupOf(r["duplicate of"] ?? "");
  if (NOOP_DECISIONS.has(decision)) { noopCount++; continue; }
  let action;
  if (decision === "empty page") action = "soft_delete";
  else if (decision === "not eligible") action = "not_eligible";
  else if (decision === "duplicate") action = "duplicate";
  else if (decision === "yes") action = "approve";
  else if (decision === "dead link" || decision === "hard delete") action = "hard_delete";
  else {
    if (!unknownDecisions.has(decision)) unknownDecisions.set(decision, []);
    unknownDecisions.get(decision).push(name);
    continue;
  }
  if (action === "duplicate" && dupOf == null)
    throw new Error(
      `Row "${name}": decision is duplicate but "duplicate of" has no artist UUID: "${r["duplicate of"] ?? ""}"`
    );
  actionRows.push({ name, url, action, dupOf });
}

console.log(`  actionable rows: ${actionRows.length}`);
console.log(`  no-action rows (blank / special case / manually handled): ${noopCount}`);
if (unknownDecisions.size) {
  console.log("  UNRECOGNIZED decisions — skipped, review by hand:");
  for (const [d, names] of unknownDecisions)
    console.log(`    "${d}" (${names.length}): ${names.join(", ")}`);
}

// --- load every artist holding a platform='hoer' link ---
async function fetchAllHoerLinks() {
  const links = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("artist_links")
      .select("artist_id, url, artists(id, name, directory_status, duplicate_of, deleted)")
      .eq("platform", "hoer")
      .range(from, from + 999);
    if (error) throw new Error(`fetch hoer links: ${error.message}`);
    links.push(...data);
    if (data.length < 1000) break;
  }
  return links;
}

const hoerLinks = await fetchAllHoerLinks();
console.log(`Loaded ${hoerLinks.length} hoer links from the DB.`);

const byUrl = new Map(); // normalized url -> [artist rows]
const byName = new Map(); // lowercased name -> [artist rows]
for (const l of hoerLinks) {
  if (!l.artists) continue;
  const u = normalizeUrl(l.url ?? "");
  if (!byUrl.has(u)) byUrl.set(u, []);
  byUrl.get(u).push(l.artists);
  const n = l.artists.name.toLowerCase();
  if (!byName.has(n)) byName.set(n, []);
  byName.get(n).push(l.artists);
}

// Bare-URL rows (the sheet lost the page slug) match by name instead. An
// artist whose HÖR page is dead may have no artist_links rows at all, so a
// name miss in the link index falls back to a direct case-insensitive lookup
// in the artists table.
const bareLookup = new Map(); // lowercased name -> [artist rows]
for (const r of actionRows) {
  if (r.url && r.url !== BARE_URL) continue;
  const key = r.name.toLowerCase();
  if (byName.has(key) || bareLookup.has(key)) continue;
  const pattern = r.name.replace(/([\\%_])/g, "\\$1");
  const { data, error } = await supabase
    .from("artists")
    .select("id, name, directory_status, duplicate_of, deleted")
    .ilike("name", pattern);
  if (error) throw new Error(`name lookup "${r.name}": ${error.message}`);
  bareLookup.set(key, data);
}

// The sheet predates some manual fixes: a row's desired end-state may already
// be in place on one of the matched artists (e.g. a dup already marked, an
// approval already granted). Such rows are counted and skipped.
function satisfies(a, action, dupOf) {
  if (action === "soft_delete") return a.deleted;
  if (action === "not_eligible") return a.directory_status === "not_eligible";
  if (action === "approve") return a.directory_status === "approved" && !a.deleted;
  if (action === "duplicate") return a.directory_status === "duplicate" && a.duplicate_of === dupOf;
  return false; // hard_delete: a surviving row never satisfies it
}

const resolved = new Map(); // artist_id -> { artist, action, dupOf, name, url }
const problems = [];
let alreadyGone = 0;
let alreadyApplied = 0;

const describe = (as) =>
  as.map((a) => `${a.id} [${a.directory_status}${a.deleted ? ", deleted" : ""}]`).join(", ");

for (const r of actionRows) {
  const candidates =
    r.url && r.url !== BARE_URL
      ? byUrl.get(r.url) ?? []
      : byName.get(r.name.toLowerCase()) ?? bareLookup.get(r.name.toLowerCase()) ?? [];
  if (candidates.length === 0) {
    if (r.action === "hard_delete" || r.action === "soft_delete") { alreadyGone++; continue; }
    problems.push(`NO MATCH for "${r.name}" (${r.url || "no url"}) — ${r.action}`);
    continue;
  }
  // One HÖR page URL can sit on several artists: dup-resolution copies the
  // link onto survivors, and the DB holds some internal pending dupes. So a
  // row acts on every candidate the decision still applies to:
  //   - candidates already in the desired end-state don't need touching;
  //   - when several candidates share the URL, only 'pending' ones are acted
  //     on (the others are survivors or already-resolved rows);
  //   - a duplicate row never marks its own target;
  //   - 'yes' must resolve to exactly one artist — approving several
  //     look-alikes at once needs a human.
  const remaining = candidates.filter((a) => !satisfies(a, r.action, r.dupOf));
  let targets =
    candidates.length === 1
      ? remaining
      : remaining.filter((a) => a.directory_status === "pending" && !a.deleted);
  if (r.action === "duplicate") targets = targets.filter((a) => a.id !== r.dupOf);
  if (targets.length === 0) {
    if (remaining.length < candidates.length) { alreadyApplied++; continue; }
    problems.push(`NO ELIGIBLE match for "${r.name}" (${r.url || "by name"}): ${describe(candidates)}`);
    continue;
  }
  if (r.action === "approve" && targets.length > 1) {
    problems.push(`AMBIGUOUS approve for "${r.name}" (${r.url || "by name"}): ${describe(targets)}`);
    continue;
  }
  for (const artist of targets) {
    const prev = resolved.get(artist.id);
    if (prev && (prev.action !== r.action || prev.dupOf !== r.dupOf)) {
      problems.push(`CONFLICT: artist ${artist.id} ("${r.name}") has both ${prev.action} and ${r.action}`);
      continue;
    }
    resolved.set(artist.id, { artist, ...r });
  }
}

if (alreadyGone) console.log(`  delete rows with no DB match (already gone, skipping): ${alreadyGone}`);
if (alreadyApplied) console.log(`  rows whose end-state is already in place (skipping): ${alreadyApplied}`);
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  throw new Error(`${problems.length} unresolved rows — fix the sheet or the matcher, then re-run.`);
}

// --- verify duplicate targets ---
const dupTargets = new Set([...resolved.values()].filter((r) => r.action === "duplicate").map((r) => r.dupOf));
const targetInfo = new Map();
if (dupTargets.size) {
  const { data, error } = await supabase
    .from("artists")
    .select("id, name, directory_status, deleted")
    .in("id", [...dupTargets]);
  if (error) throw new Error(`fetch dup targets: ${error.message}`);
  for (const a of data) targetInfo.set(a.id, a);
}
for (const t of dupTargets) {
  const info = targetInfo.get(t);
  if (!info) throw new Error(`Duplicate target ${t} not found in DB.`);
  if (info.deleted) throw new Error(`Duplicate target ${t} ("${info.name}") is soft-deleted.`);
  const r = resolved.get(t);
  if (r && (r.action === "hard_delete" || r.action === "soft_delete"))
    throw new Error(`Duplicate target ${t} ("${info.name}") is itself scheduled for ${r.action}.`);
}

// --- summarize ---
const byAction = new Map();
for (const r of resolved.values()) {
  if (!byAction.has(r.action)) byAction.set(r.action, []);
  byAction.get(r.action).push(r);
}
const statusCount = (rs) => {
  const c = {};
  for (const r of rs) {
    const s = r.artist.directory_status + (r.artist.deleted ? " (deleted)" : "");
    c[s] = (c[s] ?? 0) + 1;
  }
  return JSON.stringify(c);
};
console.log(`\nResolved ${resolved.size} artists:`);
for (const [action, rs] of byAction)
  console.log(`  ${action.padEnd(12)} ${String(rs.length).padStart(4)}   current: ${statusCount(rs)}`);

const nonPending = [...resolved.values()].filter(
  (r) => r.artist.directory_status !== "pending" || r.artist.deleted
);
if (nonPending.length) {
  console.log(`\n  NOTE — ${nonPending.length} matched artists are not plain 'pending' (listed for review):`);
  for (const r of nonPending)
    console.log(
      `    ${r.artist.id} "${r.artist.name}" [${r.artist.directory_status}${r.artist.deleted ? ", deleted" : ""}] -> ${r.action}`
    );
}

if (!APPLY) {
  console.log("\nDry run only — re-run with --apply to execute.");
  process.exit(0);
}

// --- audit trail ---
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const auditPath = path.join(REPO, "outputs", `apply-pending-hoer-decisions-${stamp}.csv`);
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
fs.writeFileSync(
  auditPath,
  ["artist_id,name,url,action,duplicate_of,prior_status,prior_deleted"]
    .concat(
      [...resolved.values()].map((r) =>
        [r.artist.id, r.name, r.url, r.action, r.dupOf, r.artist.directory_status, String(r.artist.deleted)]
          .map(esc)
          .join(",")
      )
    )
    .join("\n") + "\n"
);
console.log(`\nAudit written to ${path.relative(REPO, auditPath)}`);

console.log("Applying…");

const ids = (action) => (byAction.get(action) ?? []).map((r) => r.artist.id);

async function updateIn(list, patch, label) {
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await supabase.from("artists").update(patch).in("id", list.slice(i, i + 100));
    if (error) throw new Error(`${label}: ${error.message}`);
  }
  console.log(`  ${label}: ${list.length} done`);
}

await updateIn(ids("not_eligible"), { directory_status: "not_eligible" }, "not_eligible");
await updateIn(ids("approve"), { directory_status: "approved" }, "approve");
await updateIn(ids("soft_delete"), { deleted: true }, "soft delete");

let dupDone = 0;
for (const r of byAction.get("duplicate") ?? []) {
  const { error } = await supabase
    .from("artists")
    .update({ directory_status: "duplicate", duplicate_of: r.dupOf })
    .eq("id", r.artist.id);
  if (error) throw new Error(`dup mark ${r.artist.id}: ${error.message}`);
  dupDone++;
}
console.log(`  duplicate marks: ${dupDone} done`);

// hoer_terms' FK is ON DELETE SET NULL, but hoer_terms_bound_consistency
// requires artist_id, bind_method and bound_at to be null together — fully
// unbind the terms first so the artist delete can proceed.
const delList = ids("hard_delete");
for (let i = 0; i < delList.length; i += 100) {
  const { error } = await supabase
    .from("hoer_terms")
    .update({ artist_id: null, bind_method: null, bound_at: null })
    .in("artist_id", delList.slice(i, i + 100));
  if (error) throw new Error(`unbind hoer_terms: ${error.message}`);
}
console.log("  hoer_terms unbound for the hard-delete set");
let deleted = 0;
for (let i = 0; i < delList.length; i += 50) {
  const { data, error } = await supabase
    .from("artists")
    .delete()
    .in("id", delList.slice(i, i + 50))
    .select("id");
  if (error) throw new Error(`hard delete: ${error.message}`);
  deleted += data.length;
}
console.log(`  hard deleted: ${deleted} artists`);

console.log("\nAll done.");
