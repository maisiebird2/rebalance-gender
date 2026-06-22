#!/usr/bin/env node
// ============================================================
// Applies manual review decisions from a CSV file back into
// the database.
//
// The CSV must have `id` and `directory_status` columns; any
// additional columns are ignored. The `id` column is the UUID
// from the `artists` table.
//
// The `directory_status` column in the CSV drives what happens to each row:
//
//   duplicate     — deletes the artist row entirely (ON DELETE CASCADE
//                   removes artist_links and all other related rows)
//   <any other valid status>
//                 — updates artists.directory_status to that value
//
// Valid statuses mirror the artist_status enum: approved, pending, rejected,
// not_eligible, search_input, sc_followee, duplicate.
// Rows with an unrecognised status value are skipped with a warning.
//
// Usage (from the wem-directory/ folder):
//
//   node scripts/apply-review-csv.mjs path/to/review.csv
//   DRY_RUN=1 node scripts/apply-review-csv.mjs path/to/review.csv   # log actions, no writes
//   node scripts/apply-review-csv.mjs --debug path/to/review.csv     # log each row processed
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const csvArg = args.find((a) => !a.startsWith("--"));

if (!csvArg) {
  console.error(
    "Usage: node scripts/apply-review-csv.mjs path/to/review.csv\n" +
      "       DRY_RUN=1 node scripts/apply-review-csv.mjs path/to/review.csv"
  );
  process.exit(1);
}

const csvPath = path.resolve(process.cwd(), csvArg);
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

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
// Minimal CSV parser (handles quoted fields, embedded commas,
// embedded newlines, "" escaped quotes — no external deps).
// Same implementation used by migrate.mjs.
// ------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const normalized = text.replace(/\r\n/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];

    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length && r.some((v) => v !== ""))
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => (obj[h.trim()] = (r[idx] ?? "").trim()));
      return obj;
    });
}

// ------------------------------------------------------------
// Valid artist_status enum values — mirrors lib/types.ts ArtistStatus.
// Keep in sync if new values are added to the DB enum.
// ------------------------------------------------------------
const VALID_STATUSES = new Set([
  "approved",
  "pending",
  "rejected",
  "not_eligible",
  "search_input",
  "sc_followee",
  "duplicate",
]);

// ------------------------------------------------------------
// Process ids in chunks to stay within PostgREST's limits.
// ------------------------------------------------------------
const CHUNK_SIZE = 500;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Applying review CSV\n");
  console.log(`CSV: ${csvPath}\n`);

  const text = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCSV(text);

  if (rows.length === 0) {
    console.log("No rows found in CSV.");
    return;
  }

  const firstRow = rows[0];
  if (!("id" in firstRow) || !("directory_status" in firstRow)) {
    console.error(
      `CSV is missing required columns. Found: ${Object.keys(firstRow).join(", ")}\n` +
        "Expected at minimum: id, directory_status"
    );
    process.exit(1);
  }

  console.log(`Parsed ${rows.length} row(s) from CSV.\n`);

  // toUpdate: Map<status, id[]> — groups ids by the status they should be set to.
  // toDelete: id[] — artists to remove entirely.
  // skipped: rows with an unrecognised status.
  const toUpdate = new Map();
  const toDelete = [];
  const skipped = [];

  for (const row of rows) {
    const id = row.id?.trim();
    const status = row.directory_status?.trim();

    if (!id) {
      skipped.push({ id, status, reason: "empty id" });
      continue;
    }

    if (DEBUG) console.log(`  [debug] ${id} → ${status}`);

    if (!VALID_STATUSES.has(status)) {
      skipped.push({ id, status, reason: `unrecognised status "${status}"` });
      continue;
    }

    if (status === "duplicate") {
      toDelete.push(id);
    } else {
      if (!toUpdate.has(status)) toUpdate.set(status, []);
      toUpdate.get(status).push(id);
    }
  }

  const totalUpdates = [...toUpdate.values()].reduce((n, ids) => n + ids.length, 0);
  console.log(`  status updates:      ${totalUpdates}`);
  for (const [status, ids] of toUpdate) {
    console.log(`    ${status}: ${ids.length}`);
  }
  console.log(`  deletes (duplicate): ${toDelete.length}`);
  console.log(`  skipped:             ${skipped.length}`);
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.warn(`  ⚠ skipped ${s.id || "(no id)"}: ${s.reason}`);
    }
  }
  console.log();

  // -- status updates --
  for (const [status, ids] of toUpdate) {
    let updatedCount = 0;
    if (!DRY_RUN) {
      for (const batch of chunk(ids, CHUNK_SIZE)) {
        const { error, count } = await supabase
          .from("artists")
          .update({ directory_status: status })
          .in("id", batch)
          .select("id", { count: "exact", head: true });
        if (error) {
          console.error(`  update error (${status}): ${error.message}`);
        } else {
          updatedCount += count ?? 0;
        }
      }
      console.log(`✓ Marked ${updatedCount} artist(s) as ${status}.`);
    } else {
      console.log(`✓ (dry run) Would mark ${ids.length} artist(s) as ${status}.`);
    }
  }

  // -- deletes --
  if (toDelete.length > 0) {
    let deletedCount = 0;
    if (!DRY_RUN) {
      for (const batch of chunk(toDelete, CHUNK_SIZE)) {
        const { error, count } = await supabase
          .from("artists")
          .delete()
          .in("id", batch)
          .select("id", { count: "exact", head: true });
        if (error) {
          console.error(`  delete error: ${error.message}`);
        } else {
          deletedCount += count ?? 0;
        }
      }
      console.log(
        `✓ Deleted ${deletedCount} artist(s) (cascade removed their artist_links and all related rows).`
      );
    } else {
      console.log(
        `✓ (dry run) Would delete ${toDelete.length} artist(s) and all their related rows.`
      );
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
