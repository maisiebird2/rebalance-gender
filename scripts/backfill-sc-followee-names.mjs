// ============================================================
// Backfill sc_followee artist names that captured the wrong SoundCloud field.
// ============================================================
//
// build-soundcloud-follow-graph.mjs used to name new sc_followee artists from
// SoundCloud's `full_name` (an optional secondary field — often a real/legal
// name or junk shown beneath the display name), falling back to `username`.
// That was backwards: the name should be `username`, the primary display name.
// The builder is now fixed to use `username`; this script repairs the rows
// created while it was using full_name.
//
// It recomputes each sc_followee's name from its cached SoundCloud payload
// (api_response_cache, namespace 'soundcloud_user', cache_key = artist_id) with
// the SAME logic as the fixed ingest —
//   cleanArtistName(username) || "Unknown SoundCloud artist"
// — and updates artists.name where it differs. sc_followees are follow-graph-
// discovered and never manually curated, so recomputing is safe. Idempotent:
// re-running after a successful pass is a no-op.
//
// Dry run by default (prints what WOULD change). Pass --apply to write.
//   node scripts/backfill-sc-followee-names.mjs                 # preview only
//   node scripts/backfill-sc-followee-names.mjs --apply         # write changes
//   node scripts/backfill-sc-followee-names.mjs --limit=50      # cap rows (test)
//   node scripts/backfill-sc-followee-names.mjs --apply --debug # verbose errors

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { cleanArtistName } from "./lib/name-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DEBUG = args.includes("--debug");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

// ------------------------------------------------------------
// Load .env.local (same loader as build-soundcloud-follow-graph.mjs)
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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// PostgREST caps a single select at 1000 rows. Paginate by KEYSET (ORDER BY
// <orderCol>, then <orderCol> > cursor) rather than .range()/OFFSET: reading
// username from the payload JSONB detoasts it per row, and with OFFSET the
// deep pages also re-scan everything before the window, which together trip
// Postgres' statement_timeout on the ~135k-row cache. Keyset pages stay
// index-fast at any depth. `orderCol` must be unique and included in `select`.
const PAGE_SIZE = 1000;

async function fetchAll(table, select, applyFilters, orderCol) {
  const rows = [];
  let cursor = null;
  for (;;) {
    let query = supabase
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .limit(PAGE_SIZE);
    if (applyFilters) query = applyFilters(query);
    if (cursor !== null) query = query.gt(orderCol, cursor);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    cursor = data[data.length - 1][orderCol];
  }
  return rows;
}

// Canonical name — mirrors the ingest logic in
// build-soundcloud-follow-graph.mjs: the name is the SoundCloud `username`, with
// "Unknown …" only guarding a blank username (artists.name is NOT NULL).
// full_name is not used. Keep the two in sync.
function canonicalName(username) {
  return (
    cleanArtistName(typeof username === "string" ? username : "") ||
    "Unknown SoundCloud artist"
  );
}

async function main() {
  console.log("Loading sc_followee artists…");
  const followees = await fetchAll(
    "artists",
    "id, name",
    (q) => q.eq("directory_status", "sc_followee").eq("deleted", false),
    "id",
  );

  console.log("Loading cached SoundCloud usernames…");
  // Reads the `username` generated column (see
  // supabase_migration_cache_soundcloud_name_cols.sql) — NOT payload->>… — so
  // this doesn't detoast the JSONB and won't hit statement_timeout. Run that
  // migration first; without the column this select errors.
  //
  // Only username is needed: the name is the SoundCloud display name (username),
  // and full_name is not used for it.
  const cache = await fetchAll(
    "api_response_cache",
    "cache_key, username",
    (q) => q.eq("namespace", "soundcloud_user"),
    "cache_key",
  );
  const byId = new Map(cache.map((r) => [r.cache_key, r]));

  const changes = [];
  let missingPayload = 0;
  for (const a of followees) {
    const p = byId.get(a.id);
    if (!p) {
      missingPayload++;
      continue; // no cached payload → can't recompute, leave as-is
    }
    const corrected = canonicalName(p.username);
    if (corrected !== a.name) changes.push({ id: a.id, from: a.name, to: corrected });
  }

  console.log(`\nsc_followees:                    ${followees.length}`);
  console.log(`without a cached payload (skip):  ${missingPayload}`);
  console.log(`names that differ (to change):    ${changes.length}`);

  const preview = changes.slice(0, 20);
  for (const c of preview) console.log(`  "${c.from}"  →  "${c.to}"`);
  if (changes.length > preview.length) {
    console.log(`  … and ${changes.length - preview.length} more`);
  }

  const toApply = LIMIT != null ? changes.slice(0, LIMIT) : changes;

  if (!APPLY) {
    console.log(
      `\nDRY RUN — no writes made. Re-run with --apply to update ${toApply.length} row(s).`,
    );
    return;
  }

  console.log(`\nApplying ${toApply.length} update(s)…`);
  const CHUNK = 50;
  let done = 0;
  let failed = 0;
  for (let i = 0; i < toApply.length; i += CHUNK) {
    const chunk = toApply.slice(i, i + CHUNK);
    const errors = await Promise.all(
      chunk.map(async (c) => {
        const { error } = await supabase
          .from("artists")
          .update({ name: c.to })
          .eq("id", c.id);
        return error;
      }),
    );
    for (const err of errors) {
      if (err) {
        failed++;
        if (DEBUG) console.error(`  update failed: ${err.message}`);
      } else {
        done++;
      }
    }
    if (i % (CHUNK * 10) === 0) {
      console.log(`  …${done + failed}/${toApply.length}`);
    }
  }
  console.log(`\nDone. Updated ${done}, failed ${failed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
