#!/usr/bin/env node
// ============================================================
// Verifies the column-level SELECT grants on artists
// (supabase_migration_artists_private_columns.sql) actually hold
// against the live database, using the PUBLISHABLE key — i.e. the
// exact access an anonymous visitor has.
//
// Checks:
//   1. Every PRIVATE column is denied (PostgREST "permission denied",
//      Postgres error 42501) when selected directly.
//   2. `select=*` is denied (it implies the private columns).
//   3. The public directory read still works: the explicit public
//      column list returns at least one approved artist.
//   4. Search still works: filtering on name_search (granted for
//      WHERE-clause use but not part of the app's select list).
//
// Makes no database writes. Safe to run at any time. Exits non-zero
// if any check fails — e.g. when run before the migration has been
// applied, checks 1 and 2 will fail.
//
// Usage (from rebalance-gender/):
//
//   npm run check-artists-column-grants
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------
// Load .env.local
// ------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !publishableKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. " +
      "Fill these in in .env.local."
  );
  process.exit(1);
}

// Deliberately the publishable key: we are probing what the public can see.
const supabase = createClient(url, publishableKey);

// Must mirror supabase_migration_artists_private_columns.sql.
const PRIVATE_COLUMNS = [
  "notes",
  "submitted_by_email",
  "submitted_at",
  "reviewed_at",
  "gender_mb",
];

// The public shape the site actually selects (ARTIST_SELECT's artist
// columns in src/lib/queries.ts). Keep it in step with that select: a column
// listed here that the table no longer has fails the probe with 42703
// (undefined_column) and reads as a broken grant, which is what "labels" did
// between supabase_migration_drop_artists_labels.sql and this line being
// updated. name_search is deliberately absent — it is granted and the site
// filters on it, but never selects it, so section 3 probes it separately.
const PUBLIC_SELECT =
  "id, name, pronoun_id, directory_status, duplicate_of, " +
  "profile_image_url, profile_image_source, profile_image_fetched_at, " +
  "booking_info, management_info, contact_info, deleted, created_at, updated_at";

function isPermissionDenied(error) {
  return (
    error &&
    (error.code === "42501" || /permission denied/i.test(error.message ?? ""))
  );
}

let failures = 0;
function report(ok, label, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

console.log(`Probing ${url} with the publishable key…\n`);

// ── 1. Private columns must be denied ─────────────────────────
console.log("Private columns (expect: permission denied):");
for (const col of PRIVATE_COLUMNS) {
  const { data, error } = await supabase.from("artists").select(col).limit(1);
  if (isPermissionDenied(error)) {
    report(true, col);
  } else if (error) {
    // A different error (e.g. column does not exist) isn't proof the
    // grant is right — surface it.
    report(false, col, `unexpected error: ${error.code ?? ""} ${error.message}`);
  } else {
    const leaked = data?.length ? "returned data" : "query allowed (no rows)";
    report(false, col, leaked);
  }
}

// ── 2. select=* must be denied ────────────────────────────────
console.log("\nselect=* (expect: permission denied):");
{
  const { error } = await supabase.from("artists").select("*").limit(1);
  report(
    isPermissionDenied(error),
    "select('*')",
    error ? undefined : "query allowed"
  );
}

// ── 3. Public directory read still works ──────────────────────
console.log("\nPublic reads (expect: success):");
{
  const { data, error } = await supabase
    .from("artists")
    .select(PUBLIC_SELECT)
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .limit(1);
  if (error) {
    report(false, "public column list", `${error.code ?? ""} ${error.message}`);
  } else {
    report(
      (data ?? []).length > 0,
      "public column list",
      (data ?? []).length > 0 ? undefined : "no approved artists returned"
    );
  }
}

// ── 4. name_search filtering still works ──────────────────────
{
  const { error } = await supabase
    .from("artists")
    .select("id, name")
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .ilike("name_search", "%a%")
    .limit(1);
  report(
    !error,
    "filter on name_search",
    error ? `${error.code ?? ""} ${error.message}` : undefined
  );
}

console.log(
  failures === 0
    ? "\nAll checks passed."
    : `\n${failures} check(s) FAILED. If the migration hasn't been run yet, run ` +
        "supabase_migration_artists_private_columns.sql in the Supabase SQL editor."
);
process.exit(failures === 0 ? 0 : 1);
