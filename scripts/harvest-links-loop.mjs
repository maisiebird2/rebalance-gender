#!/usr/bin/env node
// ============================================================
// Phase 2d + 2e convergence loop — the orchestrator in miniature.
//
// Runs the direct-link harvesters, then integrate-harvested-links,
// in rounds, until a round produces no new links. Links beget links
// (a Discogs page reveals a Linktree; integrating it gives the
// Linktree harvester a new page to read), so one pass isn't enough —
// but because every harvester tracks its processed state in the
// database (resolved_artists), each round only touches artists with
// NEW links, and the loop terminates naturally.
//
// Convergence test: row counts of artist_harvested_links (staged)
// and artist_links (live) before vs. after each round. If neither
// grew, nothing new was found or promoted — stop.
//
// This loop is deliberately the skeleton for the eventual
// orchestrate.mjs: stage scripts as child processes, DB-tracked
// state, convergence detection. Add future harvesters (linktree,
// bandcamp) to the HARVESTERS array and nothing else changes.
//
// Usage (from the wem-directory/ folder):
//
//   node scripts/harvest-links-loop.mjs                  # loop to convergence (max 4 rounds)
//   node scripts/harvest-links-loop.mjs --max-rounds=2   # cap the number of rounds
//   DRY_RUN=1 node scripts/harvest-links-loop.mjs        # single round, no writes anywhere
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
// plus whatever each harvester needs — e.g. DISCOGS_TOKEN).
// ============================================================

import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// The 2d stage list. Add "harvest-links-linktree.mjs" and
// "harvest-links-bandcamp.mjs" here when they exist.
const HARVESTERS = ["harvest-links-discogs.mjs"];
const INTEGRATE = "integrate-harvested-links.mjs";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const maxRoundsArg = args.find((a) => a.startsWith("--max-rounds="));
const MAX_ROUNDS = maxRoundsArg ? parseInt(maxRoundsArg.split("=")[1], 10) : 4;

// ------------------------------------------------------------
// Load .env.local (for the row counts; child scripts load it again
// themselves).
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
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
async function tableCount(table) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

function runStage(script) {
  console.log(`\n──── running ${script} ${"─".repeat(Math.max(0, 40 - script.length))}`);
  const result = spawnSync("node", [path.join(__dirname, script)], {
    stdio: "inherit",
    env: process.env, // DRY_RUN propagates to children
  });
  if (result.status !== 0) {
    throw new Error(`${script} exited with status ${result.status}`);
  }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "DRY RUN — one round only, children write nothing\n"
      : `Link-harvest convergence loop (max ${MAX_ROUNDS} round(s))\n`
  );

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const stagedBefore = await tableCount("artist_harvested_links");
    const liveBefore = await tableCount("artist_links");

    console.log(`\n════ Round ${round} ════`);
    console.log(`Before: ${stagedBefore} staged, ${liveBefore} live links`);

    for (const harvester of HARVESTERS) runStage(harvester);
    runStage(INTEGRATE);

    if (DRY_RUN) {
      console.log("\nDRY RUN — stopping after one round (nothing was written, so counts can't change).");
      return;
    }

    const stagedAfter = await tableCount("artist_harvested_links");
    const liveAfter = await tableCount("artist_links");
    const newStaged = stagedAfter - stagedBefore;
    const newLive = liveAfter - liveBefore;

    console.log(`\nRound ${round} result: +${newStaged} staged, +${newLive} live links`);

    if (newStaged === 0 && newLive === 0) {
      console.log(`\nConverged after ${round} round(s) — no new links found or promoted.`);
      return;
    }
  }

  console.log(
    `\nStopped at --max-rounds=${MAX_ROUNDS} without converging — ` +
      "run again to continue (state is in the DB, nothing is lost)."
  );
}

main().catch((err) => {
  console.error("\nLoop failed:", err?.message ?? err);
  process.exit(1);
});
