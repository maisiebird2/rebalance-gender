#!/usr/bin/env node
// ============================================================
// Phase 2 platform-sync convergence loop — the orchestrator in miniature.
//
// Runs every platform harvester (SoundCloud 2a, Bandcamp 2b, the
// direct-link harvesters 2c, and the HÖR seeder), then
// integrate-harvested-links (2d), in rounds, until a round produces no
// new links. Links beget links
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
// One exception: if that round's integrate stage reported unwritten rows
// (exit code EXIT_PARTIAL_WRITE_FAILURES, typically a transient database
// outage), unchanged counts mean "the writes failed", not "there was
// nothing left to promote". Such a round can't declare convergence; the
// loop keeps going so the next round retries the promotion, and exits
// non-zero if the last round is still failing.
//
// This loop is deliberately the skeleton for the eventual
// orchestrate.mjs: stage scripts as child processes, DB-tracked
// state, convergence detection. Add future harvesters (e.g. linktree)
// to the HARVESTERS array and nothing else changes.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/harvest-links-loop.mjs                  # loop to convergence (max 4 rounds)
//   node scripts/harvest-links-loop.mjs --approved       # only directory artists (directory_status = 'approved')
//   node scripts/harvest-links-loop.mjs --max-rounds=2   # cap the number of rounds
//   DRY_RUN=1 node scripts/harvest-links-loop.mjs        # single round, no writes anywhere
//
// --approved is forwarded to every child stage (the harvesters and
// integrate-harvested-links), so the whole convergence loop runs
// against directory artists only.
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

// The harvester stage list — every script that stages new links into
// artist_harvested_links.
//
// sync-linktree.mjs (Phase 2c) is a full member: a Linktree page exists
// precisely to list an artist's other platforms, so it stages those into
// artist_harvested_links like any other harvester, and because Linktree
// links are themselves discovered mid-loop (a SoundCloud bio or Discogs
// page reveals a linktr.ee URL, 2d promotes it, then this script can read
// that page), it belongs in the convergence loop. It tracks processed
// state in the DB (resolved_artists / harvest_failures, service
// 'linktree-sync'), so each round only re-fetches artists whose Linktree
// link arrived since the last round, and the loop still terminates
// naturally. The same page fetch also captures the bio and (for approved
// artists) the profile image — see sync-linktree.mjs / Phase 2c.
//
// sync-bandcamp.mjs (Phase 2b) is a full member of this loop: its
// external-links sidebar is staged into artist_harvested_links like
// any other harvester, and because Bandcamp links are themselves
// discovered mid-loop (a Discogs page reveals a Bandcamp URL, 2d
// promotes it, then this script can read that Bandcamp page), it
// belongs in the convergence loop rather than as a terminal stage. It
// tracks its processed state in the DB (resolved_artists, service
// 'bandcamp-sync'), so each round only re-fetches artists whose
// Bandcamp link arrived since the last round, and the loop still
// terminates naturally. The same page fetch also does the full
// Bandcamp profile pull (discography, bio, location, image, genre
// tags) — see sync-bandcamp.mjs / Phase 2b in PIPELINE.md.
// sync-hoer.mjs (HÖR) is also a full member: it SEEDS new pending
// artists from HÖR's directory and stages their page socials
// (Instagram/SoundCloud) into artist_harvested_links, which the other
// harvesters then feed on — so it belongs in the convergence loop, not
// as a terminal stage. It tracks processed state in the DB
// (resolved_artists service 'hoer-sync' + a set-date cursor in
// hoer_sync_state), so each round only ingests new artists/sets and the
// loop still terminates. --approved gates only its enrichment, never its
// seeding. See sync-hoer.mjs.
//
// sync-soundcloud.mjs (Phase 2a) joined this loop on 2026-07-11 (was a
// standalone pre-loop orchestrator stage). It stages the "Links" section
// of each SoundCloud profile (web-profiles + bio URLs) into
// artist_harvested_links like any other harvester, and SoundCloud links
// are themselves discovered mid-loop (a HÖR page or Discogs page reveals
// one, 2d promotes it, then this reads that profile), so it belongs in
// the convergence loop rather than running once up front. The same
// /resolve call also does the full directory-artist SoundCloud pull
// (bio → artist_enrichment, image → artist_images, raw bio audit). It
// tracks processed state in the DB (resolved_artists service
// 'soundcloud-sync'), so each round only re-fetches artists whose
// SoundCloud link arrived since the last round, and the loop still
// terminates. Unlike sync-bandcamp it keeps --approved as its directory
// gate rather than being hardwired approved-only, so the loop MUST
// forward --approved (it does — see STAGE_ARGS) to keep it directory-
// only; its non-directory sc_followee counterpart is handled separately
// by build-soundcloud-follow-graph.mjs (Phase 7a), not here.
// It runs early in the round because its web-profiles fan out to many
// other platforms (Bandcamp/Spotify/Discogs/…) that later harvesters
// in the same round then consume.
const HARVESTERS = [
  "sync-hoer.mjs",
  "sync-soundcloud.mjs",
  "sync-discogs.mjs",
  "sync-linktree.mjs",
  "sync-bandcamp.mjs",
];
const INTEGRATE = "integrate-harvested-links.mjs";

// The exit code integrate-harvested-links uses for "ran to completion,
// but some rows didn't get written" (typically a transient network fault
// that outlived its own retries). Distinct from 1, which stays fatal.
//
// We tolerate it rather than aborting: the staged rows are still in the
// database and the promotion is idempotent, so the next round retries
// them for free — far cheaper than throwing away the round's harvesting.
// But a round that ended this way must NOT be allowed to satisfy the
// convergence check below: "no new live links" would then mean "the
// writes failed", not "there was nothing left to promote", and the loop
// would report a false convergence. Keep in sync with the constant of
// the same meaning in integrate-harvested-links.mjs.
const EXIT_PARTIAL_WRITE_FAILURES = 2;

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const maxRoundsArg = args.find((a) => a.startsWith("--max-rounds="));
const MAX_ROUNDS = maxRoundsArg ? parseInt(maxRoundsArg.split("=")[1], 10) : 4;
// --approved: restrict every child stage to directory artists
// (directory_status = 'approved'). Forwarded verbatim to each stage.
const APPROVED_ONLY = args.includes("--approved");
// Args forwarded to every child stage. --approved is the only one for
// now; add more pass-through flags here if the loop grows them.
const STAGE_ARGS = APPROVED_ONLY ? ["--approved"] : [];

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

// Runs one child stage. Any non-zero exit aborts the loop, except codes
// listed in `tolerate` — those are returned to the caller to interpret.
// Returns the child's exit status.
function runStage(script, { tolerate = [] } = {}) {
  const label = [script, ...STAGE_ARGS].join(" ");
  console.log(`\n──── running ${label} ${"─".repeat(Math.max(0, 40 - label.length))}`);
  const result = spawnSync("node", [path.join(__dirname, script), ...STAGE_ARGS], {
    stdio: "inherit",
    env: process.env, // DRY_RUN propagates to children
  });
  if (result.status !== 0 && !tolerate.includes(result.status)) {
    throw new Error(`${script} exited with status ${result.status}`);
  }
  return result.status;
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
  if (APPROVED_ONLY) {
    console.log("--approved: every stage restricted to directory artists (directory_status = 'approved')\n");
  }

  // Whether the round just run left rows unwritten. Declared out here so
  // it survives the loop for the exit-code check below. Only the latest
  // round matters: a later round that completes cleanly has already
  // retried (and promoted) whatever an earlier one dropped.
  let roundIncomplete = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const stagedBefore = await tableCount("artist_harvested_links");
    const liveBefore = await tableCount("artist_links");

    console.log(`\n════ Round ${round} ════`);
    console.log(`Before: ${stagedBefore} staged, ${liveBefore} live links`);

    for (const harvester of HARVESTERS) runStage(harvester);
    const integrateStatus = runStage(INTEGRATE, { tolerate: [EXIT_PARTIAL_WRITE_FAILURES] });
    roundIncomplete = integrateStatus === EXIT_PARTIAL_WRITE_FAILURES;

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
      // Static counts only prove convergence if the round actually
      // managed to write. If it didn't, "nothing promoted" is a symptom
      // of the failed writes, so keep going and give them another round.
      if (roundIncomplete) {
        console.log(
          `\nRound ${round} finished with write failures — not treating ` +
            `unchanged counts as convergence. Retrying next round.`
        );
      } else {
        console.log(`\nConverged after ${round} round(s) — no new links found or promoted.`);
        return;
      }
    }
  }

  // Ran out of rounds with the final one still failing to write. Surface
  // that to the caller — unlike plain non-convergence, this means rows
  // are sitting in staging that we tried and failed to promote.
  if (roundIncomplete) {
    console.error(
      `\nStopped at --max-rounds=${MAX_ROUNDS} with the final round still ` +
        "failing to write links (see the integrate output above). " +
        "Re-run once the database is reachable — nothing is lost."
    );
    process.exitCode = 1;
    return;
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
