#!/usr/bin/env node
// Applies the manual review decisions in "hoer-sc-followees-20260729-211957.ods"
// (in outputs/) to the artists table.
//
// Reads the sheet named "HÖR sc_followees" (falls back to the sole sheet if the
// file has exactly one). Sheet columns:
//   Artist | artist_id | SoundCloud followers | decision | notes
//
//   not eligible      -> directory_status = 'not_eligible'
//   yes / approved    -> directory_status = 'approved'
//   (empty)           -> no action
//
// Any other decision value is left alone and listed in the output for review.
// Rows are matched to artists by the artist_id column (an artist UUID), so no
// name or link matching is involved.
//
// Usage: node scripts/apply-sc-followee-decisions.mjs [--apply] [path/to.ods]
//        (default is dry-run/verify; default file is the one named above)

import "./lib/http-dispatcher.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOdsRows } from "./lib/ods-read.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const ODS =
  process.argv.slice(2).find((a) => a !== "--apply") ??
  path.join(REPO, "outputs", "hoer-sc-followees-20260729-211957.ods");

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

const SHEET_NAME = "HÖR sc_followees";

const rows = readOdsRows(ODS, { sheet: SHEET_NAME, required: ["artist_id", "decision"] });
console.log(`Read ${rows.length} data rows from ${path.basename(ODS)}.`);

// --- classify decisions ---
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The sheet uses "yes" and "approved" interchangeably for an approval.
const DECISIONS = new Map([
  ["not eligible", "not_eligible"],
  ["yes", "approved"],
  ["approved", "approved"],
]);

const wanted = new Map(); // artist_id -> { id, name, status, decision }
const unknownDecisions = new Map(); // raw decision -> [artist names]
const conflicts = [];
let noopCount = 0;

for (const r of rows) {
  const raw = (r["decision"] ?? "").trim();
  const name = (r["Artist"] ?? "").trim();
  const id = (r["artist_id"] ?? "").trim().toLowerCase();
  if (raw === "") { noopCount++; continue; }
  const status = DECISIONS.get(raw.toLowerCase());
  if (!status) {
    if (!unknownDecisions.has(raw)) unknownDecisions.set(raw, []);
    unknownDecisions.get(raw).push(name);
    continue;
  }
  if (!UUID_RE.test(id))
    throw new Error(`Row "${name}": decision is "${raw}" but artist_id is not a UUID: "${r["artist_id"] ?? ""}"`);
  const prev = wanted.get(id);
  if (prev && prev.status !== status) {
    conflicts.push(`artist ${id} ("${name}") is marked both "${prev.decision}" and "${raw}"`);
    continue;
  }
  wanted.set(id, { id, name, status, decision: raw });
}

console.log(`  rows with an actionable decision: ${wanted.size}`);
console.log(`  blank-decision rows (no action): ${noopCount}`);
if (unknownDecisions.size) {
  console.log("  UNRECOGNIZED decisions — no action taken, review by hand:");
  for (const [d, names] of unknownDecisions)
    console.log(`    "${d}" (${names.length}): ${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}`);
}
if (conflicts.length) {
  for (const c of conflicts) console.log(`  CONFLICT: ${c}`);
  throw new Error(`${conflicts.length} artist_id(s) carry contradictory decisions — fix the sheet, then re-run.`);
}

// --- load the current DB state for those artists ---
const ids = [...wanted.keys()];
const current = new Map(); // artist_id -> artist row
for (let i = 0; i < ids.length; i += 100) {
  const { data, error } = await supabase
    .from("artists")
    .select("id, name, directory_status, deleted")
    .in("id", ids.slice(i, i + 100));
  if (error) throw new Error(`fetch artists: ${error.message}`);
  for (const a of data) current.set(a.id, a);
}
console.log(`Loaded ${current.size} of ${ids.length} artists from the DB.`);

const missing = ids.filter((id) => !current.has(id));
const alreadySet = [];
const targets = []; // { id, name, status, from, deleted }

for (const w of wanted.values()) {
  const a = current.get(w.id);
  if (!a) continue;
  if (a.directory_status === w.status) { alreadySet.push(w); continue; }
  targets.push({ ...w, dbName: a.name, from: a.directory_status, deleted: a.deleted });
}

if (missing.length) {
  console.log(`\n  ${missing.length} artist_id(s) in the sheet are not in the artists table (skipped):`);
  for (const id of missing.slice(0, 20)) console.log(`    ${id} "${wanted.get(id).name}"`);
  if (missing.length > 20) console.log(`    … and ${missing.length - 20} more`);
}
if (alreadySet.length) console.log(`  already in the decided status (skipping): ${alreadySet.length}`);

// --- summarize what would change ---
const byStatus = new Map();
for (const t of targets) {
  if (!byStatus.has(t.status)) byStatus.set(t.status, []);
  byStatus.get(t.status).push(t);
}
const fromCount = (ts) => {
  const c = {};
  for (const t of ts) {
    const k = t.from + (t.deleted ? " (deleted)" : "");
    c[k] = (c[k] ?? 0) + 1;
  }
  return JSON.stringify(c);
};
console.log(`\nWould update ${targets.length} artists:`);
for (const [status, ts] of byStatus)
  console.log(`  -> ${status.padEnd(13)} ${String(ts.length).padStart(4)}   from: ${fromCount(ts)}`);

// Rows that are not plain 'sc_followee' had a status set by some other pass —
// worth a human glance, but the sheet decision still wins.
const unexpected = targets.filter((t) => t.from !== "sc_followee" || t.deleted);
if (unexpected.length) {
  console.log(`\n  NOTE — ${unexpected.length} matched artists are not plain 'sc_followee' (listed for review):`);
  for (const t of unexpected)
    console.log(`    ${t.id} "${t.dbName}" [${t.from}${t.deleted ? ", deleted" : ""}] -> ${t.status}`);
}

if (!APPLY) {
  console.log("\nDry run only — re-run with --apply to execute.");
  process.exit(0);
}

// --- audit trail ---
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const auditPath = path.join(REPO, "outputs", `apply-sc-followee-decisions-${stamp}.csv`);
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
fs.writeFileSync(
  auditPath,
  ["artist_id,sheet_name,db_name,decision,new_status,prior_status,prior_deleted"]
    .concat(
      targets.map((t) =>
        [t.id, t.name, t.dbName, t.decision, t.status, t.from, String(t.deleted)].map(esc).join(",")
      )
    )
    .join("\n") + "\n"
);
console.log(`\nAudit written to ${path.relative(REPO, auditPath)}`);

console.log("Applying…");
for (const [status, ts] of byStatus) {
  const list = ts.map((t) => t.id);
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await supabase
      .from("artists")
      .update({ directory_status: status })
      .in("id", list.slice(i, i + 100));
    if (error) throw new Error(`${status}: ${error.message}`);
  }
  console.log(`  ${status}: ${list.length} done`);
}

console.log("\nAll done.");
