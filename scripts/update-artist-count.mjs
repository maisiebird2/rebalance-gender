#!/usr/bin/env node
// ============================================================
// update-artist-count.mjs
//
// Recomputes the directory ("approved") artist count and writes a
// rounded display value to the site_stats table so the homepage can
// read ONE row instead of counting on every request.
//
//   "approved" == directory_status = 'approved' AND deleted = false
//                 (matches the public directory RLS policy)
//
// The count uses a head+exact request, so NO rows are transferred and
// the PostgREST 1000-row cap does not apply. Rounds to the nearest 100
// for display; stores the exact value too.
//
// This script is the manual / external-cron path. If you enabled the
// pg_cron job in supabase_migration_site_stats.sql, Supabase already
// refreshes this daily and you don't need to run this at all — it's
// here for one-off refreshes and local testing.
//
// ── Usage ─────────────────────────────────────────────────
//   node scripts/update-artist-count.mjs
//   npm run update-artist-count
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local
// (the secret key bypasses RLS to write site_stats).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Rounding mode: "floor" (round down) or "nearest" (nearest 100).
// "floor" so "more than X artists" copy is never an overstatement.
const ROUND_MODE = "floor";
const ROUND_TO = 100;

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
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

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

if (!URL || !SECRET) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local"
  );
  process.exit(1);
}

function roundCount(n) {
  if (ROUND_MODE === "floor") return Math.floor(n / ROUND_TO) * ROUND_TO;
  return Math.round(n / ROUND_TO) * ROUND_TO;
}

const supabase = createClient(URL, SECRET, { auth: { persistSession: false } });

// 1. Exact count — head:true means no rows come back, just the count.
const { count, error: countErr } = await supabase
  .from("artists")
  .select("id", { count: "exact", head: true })
  .eq("directory_status", "approved")
  .eq("deleted", false);

if (countErr) {
  console.error("Count query failed:", countErr);
  process.exit(1);
}

const exact = count ?? 0;
const rounded = roundCount(exact);

// 2. Upsert the single stats row.
const { error: upsertErr } = await supabase.from("site_stats").upsert(
  {
    key: "approved_artist_count",
    value_int: rounded,
    exact_int: exact,
    updated_at: new Date().toISOString(),
  },
  { onConflict: "key" }
);

if (upsertErr) {
  console.error("Upsert into site_stats failed:", upsertErr);
  process.exit(1);
}

console.log(
  `approved_artist_count: exact=${exact} -> displayed=${rounded} (${ROUND_MODE} ${ROUND_TO})`
);
