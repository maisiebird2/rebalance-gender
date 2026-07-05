#!/usr/bin/env node
// ============================================================
// Platform enrichment & link harvesting orchestrator (Phase 2).
//
// Runs the platform-enrichment loop end to end, in dependency order,
// as a single command:
//
//   1. clean-artist-names.mjs             — data-quality prerequisite:
//                                           trims invisible characters /
//                                           whitespace from artist names
//                                           before anything uses them as
//                                           a search key. Global by
//                                           design (not restricted to
//                                           approved), so --approved is
//                                           NOT forwarded to it.
//   2. enrich-soundcloud.mjs              — profile data (followers,
//                                           tracks, bio, image) for
//                                           every SoundCloud link.
//   3. harvest-soundcloud-links-and-bio.mjs — stages the other-platform
//                                           links + bios from each
//                                           SoundCloud "Links" section.
//   4. harvest-links-loop.mjs             — the convergence loop:
//                                           runs the direct-link
//                                           harvesters (Discogs, …) +
//                                           integrate-harvested-links
//                                           in rounds until no new
//                                           links appear, promoting the
//                                           staged links from step 3
//                                           into artist_links.
//   5. enrich-bandcamp.mjs                — scrapes each artist's
//                                           Bandcamp discography. Runs
//                                           LAST because it depends on
//                                           Bandcamp links that step 4
//                                           may have just promoted into
//                                           artist_links. Already
//                                           directory-only (it always
//                                           filters directory_status =
//                                           'approved').
//
// This is the same ordering as Phase 1 → Phase 2 of PIPELINE.md, wired
// together so it can be launched (and, later, scheduled) with one flag.
//
// --approved
// ----------
// The whole point of this orchestrator: pass --approved and every
// stage is restricted to artists in the live directory
// (directory_status = 'approved'), instead of every artist with a
// platform link — which is dominated by unvetted follow-graph nodes
// (directory_status = 'sc_followee'). The flag is forwarded verbatim
// to each child stage, and harvest-links-loop forwards it again to its
// own children (the harvesters + integrate), so a single --approved
// flag governs the entire loop.
//
// Each stage tracks its processed state in the DATABASE
// (resolved_artists), not a cache file, so the orchestrator holds no
// state of its own and is safe to re-run — a second run only touches
// artists that gained new data since the last one.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/orchestrate-platform-enrichment.mjs                 # all artists with a platform link
//   node scripts/orchestrate-platform-enrichment.mjs --approved      # only directory artists (directory_status = 'approved')
//   node scripts/orchestrate-platform-enrichment.mjs --approved --max-rounds=2
//                                                                    # cap the harvest-links-loop rounds
//   DRY_RUN=1 node scripts/orchestrate-platform-enrichment.mjs --approved
//                                                                    # fetch + log, no DB writes (propagates to every stage)
//
// Requires .env.local with whatever the child stages need
// (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, SOUNDCLOUD_CLIENT_ID,
// SOUNDCLOUD_CLIENT_SECRET, DISCOGS_TOKEN). Each child loads .env.local
// itself, so the orchestrator doesn't need to.
// ============================================================

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const APPROVED_ONLY = args.includes("--approved");
const maxRoundsArg = args.find((a) => a.startsWith("--max-rounds="));

// ------------------------------------------------------------
// Run one stage as a child process, forwarding stdio and env (so
// DRY_RUN reaches the child). Throws on a non-zero exit so the
// orchestration stops at the first failing stage rather than running
// the rest against a half-finished state. Mirrors harvest-links-loop's
// runStage.
// ------------------------------------------------------------
function runStage(script, stageArgs = []) {
  const label = [script, ...stageArgs].join(" ");
  console.log(`\n════════ ${label} ${"═".repeat(Math.max(0, 48 - label.length))}`);
  const result = spawnSync("node", [path.join(__dirname, script), ...stageArgs], {
    stdio: "inherit",
    env: process.env, // DRY_RUN (and everything else) propagates to children
  });
  if (result.error) {
    throw new Error(`Failed to launch ${script}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${script} exited with status ${result.status}`);
  }
}

// ------------------------------------------------------------
// The orchestration function. Kept as a named, exported function so it
// can also be driven from another script (e.g. a future full-pipeline
// orchestrate.mjs) or a scheduled job, not only this file's CLI.
//
//   opts.approvedOnly  — restrict every stage to directory artists.
//   opts.maxRounds     — optional cap forwarded to harvest-links-loop.
//
// Returns the ordered list of stages it ran (handy for logging/tests).
// ------------------------------------------------------------
export function orchestratePlatformEnrichment(opts = {}) {
  const { approvedOnly = false, maxRounds = null } = opts;

  // The one flag the directory-restrictable stages share.
  // harvest-links-loop forwards it on to its own children, so this
  // single entry governs the whole loop.
  const common = approvedOnly ? ["--approved"] : [];

  const stages = [
    // clean-artist-names is a global data-quality pass — it cleans every
    // artist's name regardless of directory_status, so --approved is not
    // forwarded to it.
    { script: "clean-artist-names.mjs", args: [] },
    { script: "enrich-soundcloud.mjs", args: [...common] },
    { script: "harvest-soundcloud-links-and-bio.mjs", args: [...common] },
    {
      script: "harvest-links-loop.mjs",
      args: [...common, ...(maxRounds != null ? [`--max-rounds=${maxRounds}`] : [])],
    },
    // enrich-bandcamp is already directory-only (always filters
    // directory_status = 'approved'); forwarding --approved is harmless
    // and keeps intent explicit.
    { script: "enrich-bandcamp.mjs", args: [...common] },
  ];

  for (const { script, args: stageArgs } of stages) {
    runStage(script, stageArgs);
  }

  return stages;
}

// ------------------------------------------------------------
// Main (CLI entry)
// ------------------------------------------------------------
function main() {
  console.log(
    DRY_RUN
      ? "DRY RUN — orchestrating platform-enrichment stages, children write nothing\n"
      : "Orchestrating platform enrichment & link harvesting stages\n"
  );
  if (APPROVED_ONLY) {
    console.log("--approved: every stage restricted to directory artists (directory_status = 'approved')\n");
  }

  const maxRounds = maxRoundsArg ? parseInt(maxRoundsArg.split("=")[1], 10) : null;

  const stages = orchestratePlatformEnrichment({ approvedOnly: APPROVED_ONLY, maxRounds });

  console.log(`\n✓ Orchestration complete — ran ${stages.length} stage(s)${DRY_RUN ? " (dry run)" : ""}.`);
}

main();
