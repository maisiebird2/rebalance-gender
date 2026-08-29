#!/usr/bin/env node
// ============================================================
// Backfill: resolve shortened / share URLs already stored in artist_links.
//
// Rows reach the live table holding a link whose real target is only
// knowable over the network — an on.soundcloud.com share link, a
// soundcloud.app.goo.gl, a bit.ly. This walks those rows, follows each
// redirect, and rewrites the row to point at the real destination.
//
// All of the actual decision-making lives in
// src/lib/resolve-artist-links.ts (which in turn calls
// src/lib/resolve-url-redirects.ts for the network step). This script is
// deliberately thin: arguments, a progress log, a CSV, a summary. That is
// what lets the same logic run from the form save paths via after() and
// from here, without the two drifting.
// See documentation/URL-RESOLUTION-PLAN.md.
//
// ------------------------------------------------------------
// This script is also the drain for the form paths' after() work.
//
// There is no queue table. The set of rows needing resolution is exactly
// "rows whose host is in the resolver's tier table", which is derivable
// from the URL itself — so this scan IS the queue. A save whose after()
// callback never ran (deploy mid-request, cold start, transient network)
// leaves a row this script will find on its next run, with no bookkeeping
// to get out of sync. Adding a host to the tier table likewise
// re-enqueues all of history for free.
//
// ------------------------------------------------------------
// What it will NOT do
//
//   - Overwrite a row whose destination 404s. A shortener can resolve
//     perfectly to a profile that no longer exists; keeping the original
//     is better than storing a known-dead URL.
//   - Trust a redirect that lands somewhere implausible. spotify.link
//     bounces to a Branch deep link and vm.tiktok.com to the TikTok
//     homepage; both are worse than the link we started with, so they are
//     reported and left alone.
//   - Merge two links. If resolving a row would move it onto a
//     (artist_id, platform) pair the artist already has AND the two
//     point somewhere different, that's a unique-constraint collision
//     AND a judgement call about which link wins. Reported for a human,
//     never guessed at.
//   - Delete anything, unless --delete-duplicates says otherwise. Even
//     then it removes only rows that resolve to EXACTLY the URL the
//     artist already holds under the right platform — never a
//     collision, where the two links genuinely differ.
//   - Clobber an existing original_url. The pre-resolution URL is saved
//     there only when the column is empty, so re-runs are idempotent and
//     a truer original is never lost.
//
// ------------------------------------------------------------
// Output
//
// Every run writes a CSV of every row it examined — proposed changes and
// skips with their reasons — to the output folder (see
// documentation/OUTPUT-FILE-LOCATION.md). In a dry run that CSV is the
// point of the exercise: read it before letting the script write.
//
// Usage (from the rebalance-gender/ folder):
//
//   npm run resolve-link-redirects -- --dry-run         # report only, no writes
//   npm run resolve-link-redirects                      # rewrite live rows
//   npm run resolve-link-redirects -- --delete-duplicates  # also drop redundant copies
//   npm run resolve-link-redirects -- --host=goo.gl     # one host only
//   npm run resolve-link-redirects -- --artist=<uuid>   # one artist
//   npm run resolve-link-redirects -- --ids=12,34       # specific artist_links rows
//   npm run resolve-link-redirects -- --limit=20        # cap rows examined
//   npm run resolve-link-redirects -- --delay=300       # ms between network calls
//   npm run resolve-link-redirects -- --debug           # log every row's decision
//   DRY_RUN=1 npm run resolve-link-redirects            # same as --dry-run
//
// Must run under tsx, not node: it imports TypeScript from src/lib.
// That's what the npm script is for.
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// Safe to re-run: a resolved URL is never itself a resolvable host, so a
// second run finds nothing left to do.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { outputPath } from "./lib/output-path.mjs";
import { resolveArtistLinks } from "../src/lib/resolve-artist-links.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
// Both spellings: --dry-run reads better here, DRY_RUN=1 is the convention
// every other script in this folder uses.
const DRY_RUN = args.includes("--dry-run") || process.env.DRY_RUN === "1";
// Removes rows that resolve to exactly what the artist already holds under the
// right platform. Opt-in because everything else here rewrites rather than
// removes, and that difference should be visible in the command you typed.
const DELETE_DUPLICATES = args.includes("--delete-duplicates");

const valueArg = (name) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

const HOST = valueArg("host");
const ARTIST = valueArg("artist");
const IDS = valueArg("ids");
const LIMIT = valueArg("limit") ? parseInt(valueArg("limit"), 10) : null;
const DELAY_MS = valueArg("delay") ? parseInt(valueArg("delay"), 10) : undefined;

if (ARTIST && IDS) {
  console.error("Pass --artist or --ids, not both.");
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
// Base origin for the artist edit links written into the CSV. Mirrors the
// fallback used across src/ (e.g. src/app/layout.tsx).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rebalance-gender.app";

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
// Helpers
// ------------------------------------------------------------
function runTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function csvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Artist names for the CSV, so a reviewer can tell whose link this is. */
async function fetchArtistNames(artistIds) {
  const nameById = new Map();
  for (let i = 0; i < artistIds.length; i += 200) {
    const batch = artistIds.slice(i, i + 200);
    const { data, error } = await supabase.from("artists").select("id, name").in("id", batch);
    if (error) {
      console.error(`  Could not fetch artist names for the CSV: ${error.message}`);
      return nameById;
    }
    for (const a of data) nameById.set(a.id, a.name);
  }
  return nameById;
}

const CSV_COLUMNS = [
  "status",
  "reason",
  "artist_name",
  "artist_url",
  "link_id",
  "platform",
  "new_platform",
  "url",
  "new_url",
  "new_handle",
  // When a row overflows into "other", the link already sitting in the slot it
  // would otherwise have taken. Nothing has to be decided about it any more,
  // but a report that says "this went to other" without saying what holds the
  // platform is a report nobody can check.
  "conflicting_link_id",
  "conflicting_url",
  "destination_seen",
  "final_status",
];

async function writeReportCsv(outcomes) {
  const ids = [...new Set(outcomes.map((o) => o.artistId))];
  const nameById = await fetchArtistNames(ids);

  const lines = [CSV_COLUMNS.join(",")];
  for (const o of outcomes) {
    lines.push(
      [
        // In a dry run nothing was written, so say so rather than claiming
        // rows were updated.
        DRY_RUN && o.status === "updated"
          ? "would-update"
          : DRY_RUN && o.status === "deleted"
            ? "would-delete"
            : o.status,
        o.reason ?? "",
        nameById.get(o.artistId) ?? "",
        `${SITE_URL}/artist/${o.artistId}/edit`,
        o.id,
        o.platform,
        o.newPlatform ?? "",
        o.url,
        o.newUrl ?? "",
        o.newHandle ?? "",
        o.conflictLinkId ?? "",
        o.conflictUrl ?? "",
        o.destination ?? "",
        o.finalStatus ?? "",
      ]
        .map(csvField)
        .join(",")
    );
  }

  const filename = `link-redirect-resolution-${runTimestamp()}.csv`;
  const out = outputPath(filename);
  fs.writeFileSync(out, lines.join("\n") + "\n", "utf-8");
  return out;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    DRY_RUN
      ? "Running in DRY RUN mode (no writes)\n"
      : "Resolving shortened URLs in artist_links\n"
  );

  let scope = { all: true };
  if (ARTIST) {
    scope = { artistId: ARTIST };
    console.log(`--artist: restricting to ${ARTIST}`);
  } else if (IDS) {
    const ids = IDS.split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n));
    if (ids.length === 0) {
      console.error("--ids did not contain any usable artist_links ids.");
      process.exit(1);
    }
    scope = { ids };
    console.log(`--ids: restricting to ${ids.length} row(s)`);
  }
  if (HOST) console.log(`--host: restricting to URLs containing "${HOST}"`);
  if (LIMIT) console.log(`--limit: examining at most ${LIMIT} row(s)`);
  console.log("");

  const outcomes = [];
  const report = await resolveArtistLinks(supabase, scope, {
    dryRun: DRY_RUN,
    host: HOST ?? undefined,
    limit: LIMIT ?? undefined,
    delayMs: DELAY_MS,
    deleteDuplicates: DELETE_DUPLICATES,
    onProgress: (o) => {
      outcomes.push(o);
      if (o.status === "updated") {
        console.log(`${DRY_RUN ? "would update" : "updated"} #${o.id}  ${o.platform} -> ${o.newPlatform}`);
        console.log(`    ${o.url}`);
        console.log(` -> ${o.newUrl}${o.newHandle ? `   handle=${o.newHandle}` : ""}`);
        if (o.conflictLinkId) {
          console.log(`    overflow: #${o.conflictLinkId} already holds ${o.conflictUrl}`);
        }
      } else if (o.status === "deleted") {
        // Always logged, never hidden behind --debug: a deletion is the one
        // thing here that removes data, so it should be visible by default.
        console.log(`${DRY_RUN ? "would delete" : "deleted"} #${o.id}  ${o.platform}  ${o.url}`);
        console.log(`    redundant: #${o.conflictLinkId} already holds ${o.conflictUrl}`);
      } else if (DEBUG) {
        console.log(`skipped #${o.id}  ${o.reason}  ${o.url}`);
        if (o.destination) console.log(`    saw ${o.destination} [${o.finalStatus ?? "?"}]`);
        if (o.reason === "duplicate-of-existing") {
          console.log(`    redundant: #${o.conflictLinkId} already holds: ${o.conflictUrl}`);
        }
      }
    },
  });

  // ---- Summary ----
  const label = (text) => `${text}:`.padEnd(34);
  console.log("\n" + "-".repeat(60));
  console.log(`${label("Rows examined (resolvable host)")}${report.examined}`);
  console.log(`${label(DRY_RUN ? "Would rewrite" : "Rewritten")}${report.updated.length}`);
  if (DELETE_DUPLICATES) {
    console.log(`${label(DRY_RUN ? "Would delete as redundant" : "Deleted as redundant")}${report.deleted.length}`);
  }
  console.log(`${label("Left alone")}${report.skipped.length}`);

  if (report.skipped.length > 0) {
    const byReason = new Map();
    for (const s of report.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    console.log("\nWhy rows were left alone:");
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${reason}`);
    }
  }

  if (report.updated.length > 0) {
    const byMove = new Map();
    for (const u of report.updated) {
      const key = `${u.platform} -> ${u.newPlatform}`;
      byMove.set(key, (byMove.get(key) ?? 0) + 1);
    }
    console.log(`\nPlatform ${DRY_RUN ? "moves proposed" : "moves"}:`);
    for (const [move, count] of [...byMove.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${move}`);
    }
  }

  // Two links, one slot. Split by whether it's a real contest or just a copy,
  // because only one of the two needs anybody to think about it.
  const duplicates = report.skipped.filter((s) => s.reason === "duplicate-of-existing");
  if (duplicates.length > 0) {
    console.log(
      `\n${duplicates.length} row(s) resolve to a URL the artist already has under the right ` +
        `platform — redundant copies. Check them in the CSV, then re-run with ` +
        `--delete-duplicates to remove them.`
    );
  }

  // Not an action item any more, just a count worth seeing. A row resolving to
  // a DIFFERENT link than the one the artist already has for that platform
  // used to need a human to pick a winner; since the overflow bucket opened up
  // (supabase_migration_artist_links_overflow.sql) both links are simply kept,
  // the incumbent as the primary and this one under "other".
  const overflowed = report.updated.filter((u) => u.newPlatform === "other" && u.conflictLinkId);
  if (overflowed.length > 0) {
    console.log(
      `\n${overflowed.length} row(s) resolved to a platform the artist already has, so they ` +
        `were kept as "other" links rather than taking the slot. See the new_platform and ` +
        `conflicting_url columns in the CSV.`
    );
  }

  if (outcomes.length > 0) {
    const csvPath = await writeReportCsv(outcomes);
    console.log(`\nReport written to ${csvPath}`);
  } else {
    console.log("\nNothing to resolve — no CSV written.");
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no changes written. Re-run without --dry-run to apply.");
  } else {
    console.log("\nDone.");
  }
}

main().catch((err) => {
  console.error("\nBackfill failed:", err?.message ?? err);
  process.exit(1);
});
