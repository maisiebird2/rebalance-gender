#!/usr/bin/env node
// ============================================================
// apply-hoer-dupe-review.mjs — round-trip importer for the reviewed
// inferred-duplicate CSV produced by resolve-hoer-status.mjs.
//
// Reads a reviewed hoer-inferred-dupes-review-*.csv (the `decision` column
// filled in by hand) and applies each decision:
//
//   decision = duplicate -> directory_status = 'duplicate'
//   decision = approve   -> directory_status = 'approved'
//   decision = reject    -> directory_status = 'rejected'
//   blank / anything else -> skipped
//
// Keyed on the stable `artist_id`, and it only touches rows that are STILL
// directory_status='pending' — so a re-upload can't clobber a status that was
// changed by hand in between, and the uploaded file can safely be a filtered
// subset of the review output.
//
// Writes hoer-dupe-review-applied-<stamp>.csv recording what changed and what
// was skipped and why.
//
// Usage (from the repo root):
//   node scripts/apply-hoer-dupe-review.mjs reviewed.csv
//   node scripts/apply-hoer-dupe-review.mjs --dry-run reviewed.csv
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { loadEnvLocal, createSupabase } from "./lib/hoer-db.mjs";
import { parseCSV, writeCSV, timestamp } from "./lib/hoer-resolve.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run") || process.env.DRY_RUN === "1";
const DEBUG = args.includes("--debug");
const csvArg = args.find((a) => !a.startsWith("--"));

if (!csvArg) {
  console.error(
    "Usage: node scripts/apply-hoer-dupe-review.mjs [--dry-run] path/to/reviewed.csv"
  );
  process.exit(1);
}
const csvPath = path.resolve(process.cwd(), csvArg);
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

// decision -> target directory_status
const DECISION_STATUS = {
  duplicate: "duplicate",
  approve: "approved",
  reject: "rejected",
};

loadEnvLocal();

async function main() {
  console.log(DRY_RUN ? "DRY RUN — no DB writes.\n" : "Applying reviewed decisions.\n");
  console.log(`CSV: ${csvPath}\n`);

  const supabase = createSupabase();
  const rows = parseCSV(fs.readFileSync(csvPath, "utf-8"));

  if (rows.length === 0) {
    console.log("No rows found in CSV.");
    return;
  }
  if (!("artist_id" in rows[0]) || !("decision" in rows[0])) {
    console.error(
      `CSV is missing required columns. Found: ${Object.keys(rows[0]).join(", ")}\n` +
        "Expected at least: artist_id, decision"
    );
    process.exit(1);
  }

  const applied = []; // audit rows
  const seen = new Set(); // guard against duplicate artist_id rows in the file
  let changed = 0;
  let skipped = 0;

  for (const row of rows) {
    const artistId = (row.artist_id ?? "").trim();
    const decision = (row.decision ?? "").trim().toLowerCase();

    const record = (result, note) => {
      applied.push({
        artist_id: artistId,
        hoer_name: row.hoer_name ?? "",
        decision,
        result,
        note,
      });
      if (result === "changed") changed++;
      else skipped++;
    };

    if (!artistId) {
      record("skipped", "empty artist_id");
      continue;
    }
    if (!decision) {
      record("skipped", "blank decision");
      continue;
    }
    if (!(decision in DECISION_STATUS)) {
      record("skipped", `unrecognised decision "${decision}"`);
      continue;
    }
    if (seen.has(artistId)) {
      record("skipped", "duplicate artist_id row in file");
      continue;
    }
    seen.add(artistId);

    const targetStatus = DECISION_STATUS[decision];
    if (DEBUG) console.log(`  ${artistId} decision=${decision} -> ${targetStatus}`);

    if (DRY_RUN) {
      record("would-change", `-> ${targetStatus} (if still pending)`);
      continue;
    }

    // Guard: only update rows still pending. head+count tells us whether a
    // row actually matched (i.e. was still pending) without a second read.
    const { error, count } = await supabase
      .from("artists")
      .update({ directory_status: targetStatus })
      .eq("id", artistId)
      .eq("directory_status", "pending")
      .select("id", { count: "exact", head: true });

    if (error) {
      record("error", error.message);
      console.error(`  update error (${artistId}): ${error.message}`);
    } else if ((count ?? 0) === 0) {
      record("skipped", "not found or no longer pending");
    } else {
      record("changed", `-> ${targetStatus}`);
    }
  }

  console.log(`\nchanged: ${changed}   skipped: ${skipped}\n`);

  const outPath = path.resolve(process.cwd(), `hoer-dupe-review-applied-${timestamp()}.csv`);
  writeCSV(outPath, ["artist_id", "hoer_name", "decision", "result", "note"], applied);
  console.log(`Wrote audit log:\n  ${outPath}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
