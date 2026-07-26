#!/usr/bin/env node
// One-off, executed 2026-07-26 — kept for the record.
//
// Applies decisions from "hoer-exact-ambiguous-20260719-173542 MOD.csv".
//
//   dead link, empty page                  -> hard-delete artist row
//   duplication handled in RG / manually
//   handled / gender unclear / ???         -> no action
//   HOER not eligible                      -> directory_status = 'not_eligible'
//   new artist                             -> directory_status = 'approved'
//   to process + dup status 'dup to mark'  -> directory_status = 'duplicate',
//                                             duplicate_of = matched_artist_id;
//                                             matched artist: sc_followee -> approved
//   to process + dup status empty          -> no action
//
// Usage: node apply-hoer-decisions-2026-07-26.mjs [--apply]   (default is dry-run/verify)

import "./lib/http-dispatcher.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const REPO = "/Users/maisiebird/Claude/Projects/Rebalance Gender/rebalance-gender-repo";
const CSV = "/Users/maisiebird/Claude/Projects/Rebalance Gender/output files/hoer-exact-ambiguous-20260719-173542 MOD.csv";
const APPLY = process.argv.includes("--apply");

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

// --- minimal CSV parser (handles quoted fields with commas) ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  const [header, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const rows = parseCsv(fs.readFileSync(CSV, "utf-8"));

// Ø [Phase]: sheet says not eligible, but it was manually marked duplicate in
// the DB after the sheet was exported — user chose to keep the dup marking.
const SKIP_IDS = new Set(["24347e3b-9210-471f-8f23-d4e6e379ebdd"]);

const DELETE_DECISIONS = new Set(["dead link", "empty page"]);
const NOOP_DECISIONS = new Set(["duplication handled in RG", "manually handled", "gender unclear", "???"]);

const toDelete = new Set();
const toNotEligible = new Set();
const toApprove = new Set();
const dupMarks = new Map(); // artist_id -> matched_artist_id
const decisionsSeen = new Map(); // artist_id -> Set(decisions)

for (const r of rows) {
  const d = r["decision"];
  const id = r["artist_id"];
  if (SKIP_IDS.has(id)) continue;
  if (!decisionsSeen.has(id)) decisionsSeen.set(id, new Set());
  decisionsSeen.get(id).add(d);
  if (DELETE_DECISIONS.has(d)) toDelete.add(id);
  else if (d === "HOER not eligible") toNotEligible.add(id);
  else if (d === "new artist") toApprove.add(id);
  else if (d === "to process") {
    if (r["dup status"] === "dup to mark") {
      const prev = dupMarks.get(id);
      if (prev && prev !== r["matched_artist_id"])
        throw new Error(`Artist ${id} has two different dup targets: ${prev} vs ${r["matched_artist_id"]}`);
      dupMarks.set(id, r["matched_artist_id"]);
    }
  } else if (!NOOP_DECISIONS.has(d)) throw new Error(`Unknown decision "${d}" for artist ${id}`);
}

// No artist may fall into two different action groups.
const groups = [
  ["delete", toDelete],
  ["not_eligible", toNotEligible],
  ["approve", toApprove],
  ["dup_mark", new Set(dupMarks.keys())],
];
for (let i = 0; i < groups.length; i++)
  for (let j = i + 1; j < groups.length; j++)
    for (const id of groups[i][1])
      if (groups[j][1].has(id))
        throw new Error(`Artist ${id} is in both ${groups[i][0]} and ${groups[j][0]}`);

console.log(`Parsed ${rows.length} rows.`);
console.log(`  delete:        ${toDelete.size}`);
console.log(`  not_eligible:  ${toNotEligible.size}`);
console.log(`  approve:       ${toApprove.size}`);
console.log(`  dup marks:     ${dupMarks.size}`);

// --- verify all referenced IDs exist ---
async function fetchArtists(ids) {
  const out = new Map();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, directory_status, duplicate_of, deleted")
      .in("id", list.slice(i, i + 100));
    if (error) throw new Error(`fetch artists: ${error.message}`);
    for (const a of data) out.set(a.id, a);
  }
  return out;
}

const actionIds = new Set([...toDelete, ...toNotEligible, ...toApprove, ...dupMarks.keys()]);
const targetIds = new Set(dupMarks.values());
const all = await fetchArtists(new Set([...actionIds, ...targetIds]));

let missing = 0;
let alreadyDeleted = 0;
for (const id of actionIds) {
  if (all.has(id)) continue;
  if (toDelete.has(id)) { toDelete.delete(id); alreadyDeleted++; }
  else { console.log(`MISSING artist ${id}`); missing++; }
}
if (alreadyDeleted) console.log(`  already deleted (skipping): ${alreadyDeleted}`);
for (const id of targetIds)
  if (!all.has(id)) { console.log(`MISSING dup target ${id}`); missing++; }
if (missing) throw new Error(`${missing} referenced artists not found in DB — aborting.`);

// Dup targets that are themselves scheduled for deletion would leave a
// dangling duplicate_of (FK sets it NULL) — flag before applying.
for (const [id, target] of dupMarks)
  if (toDelete.has(target))
    throw new Error(`Dup target ${target} (for ${id}) is scheduled for deletion.`);

const promoteToApproved = [...targetIds].filter((id) => all.get(id).directory_status === "sc_followee");
console.log(`  dup targets currently sc_followee (will promote): ${promoteToApproved.length}`);

const statusCount = (ids) => {
  const c = {};
  for (const id of ids) { const s = all.get(id).directory_status; c[s] = (c[s] ?? 0) + 1; }
  return JSON.stringify(c);
};
console.log(`  current statuses of deletes:      ${statusCount(toDelete)}`);
console.log(`  current statuses of not_eligible: ${statusCount(toNotEligible)}`);
console.log(`  current statuses of approvals:    ${statusCount(toApprove)}`);
console.log(`  current statuses of dup marks:    ${statusCount(dupMarks.keys())}`);
console.log(`  current statuses of dup targets:  ${statusCount(targetIds)}`);

if (!APPLY) {
  console.log("\nDry run only — re-run with --apply to execute.");
  process.exit(0);
}

console.log("\nApplying…");

async function updateIn(ids, patch, label) {
  const list = [...ids];
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await supabase.from("artists").update(patch).in("id", list.slice(i, i + 100));
    if (error) throw new Error(`${label}: ${error.message}`);
  }
  console.log(`  ${label}: ${list.length} done`);
}

await updateIn(toNotEligible, { directory_status: "not_eligible" }, "not_eligible");
await updateIn(toApprove, { directory_status: "approved" }, "approve");

let dupDone = 0;
for (const [id, target] of dupMarks) {
  const { error } = await supabase
    .from("artists")
    .update({ directory_status: "duplicate", duplicate_of: target })
    .eq("id", id);
  if (error) throw new Error(`dup mark ${id}: ${error.message}`);
  dupDone++;
}
console.log(`  dup marks: ${dupDone} done`);

await updateIn(promoteToApproved, { directory_status: "approved" }, "promote sc_followee targets");

// hoer_terms' FK is ON DELETE SET NULL, but hoer_terms_bound_consistency
// requires artist_id, bind_method and bound_at to be null together — fully
// unbind the terms first so the artist delete can proceed.
const delList = [...toDelete];
for (let i = 0; i < delList.length; i += 100) {
  const { error } = await supabase
    .from("hoer_terms")
    .update({ artist_id: null, bind_method: null, bound_at: null })
    .in("artist_id", delList.slice(i, i + 100));
  if (error) throw new Error(`unbind hoer_terms: ${error.message}`);
}
console.log("  hoer_terms unbound for delete set");
let deleted = 0;
for (let i = 0; i < delList.length; i += 50) {
  const batch = delList.slice(i, i + 50);
  const { data, error } = await supabase.from("artists").delete().in("id", batch).select("id");
  if (error) throw new Error(`delete: ${error.message}`);
  deleted += data.length;
}
console.log(`  deleted: ${deleted} artists`);

console.log("\nAll done.");
