#!/usr/bin/env node
// ============================================================
// migrate-hoer-dupe-links.mjs — copy the HÖR link from each artist that
// resolve-hoer-status.mjs marked as an exact `duplicate` onto the surviving
// (matched) artist, so the HÖR association lands on the row that stays in the
// directory instead of being stranded on the `duplicate` row.
//
// INPUT: a hoer-status-resolution-<stamp>.csv produced by resolve-hoer-status.
// Only rows with rule='exact_duplicate' are acted on; every other row (pronoun
// decisions etc.) is ignored. For each such row:
//
//   artist_id        -> the HÖR artist now marked `duplicate`   (link source)
//   matched_artist_id-> the surviving artist it duplicates       (link target)
//
// For each pair we COPY the source's platform='hoer' link onto the target by
// INSERTing a new artist_links row (the source keeps its own link as a record).
//
// Guards (a pair is skipped + logged, never forced):
//   - target artist missing or deleted            -> skip
//   - source artist is not currently `duplicate`  -> skip (resolution not applied,
//                                                     e.g. a --dry-run report, or
//                                                     a human reverted it)
//   - source has no platform='hoer' link          -> skip (nothing to copy)
//   - target already has a hoer link, SAME url     -> skip (already present; idempotent)
//   - target already has a hoer link, DIFFERENT url-> skip (conflict — the
//         (artist_id, platform) unique constraint allows only one; needs a human)
//
// Writes hoer-link-migration-applied-<stamp>.csv recording every action.
//
// Usage (from the repo root):
//   node scripts/migrate-hoer-dupe-links.mjs hoer-status-resolution-<stamp>.csv
//   node scripts/migrate-hoer-dupe-links.mjs --dry-run hoer-status-resolution-<stamp>.csv
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
    "Usage: node scripts/migrate-hoer-dupe-links.mjs [--dry-run] path/to/hoer-status-resolution-<stamp>.csv"
  );
  process.exit(1);
}
const csvPath = path.resolve(process.cwd(), csvArg);
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

const HOER = "hoer";

loadEnvLocal();

// Fetch platform='hoer' links (full row) for a set of artist ids, in chunks so
// the .in() list never gets unwieldy. Returns Map artist_id -> link row. The
// (artist_id, platform) unique constraint means at most one hoer link per artist.
async function loadHoerLinksFor(supabase, ids) {
  const map = new Map();
  const list = [...ids];
  const CHUNK = 300;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("artist_links")
      .select("id, artist_id, platform, handle, url, original_url, not_found")
      .eq("platform", HOER)
      .in("artist_id", slice);
    if (error) throw error;
    for (const r of data) map.set(r.artist_id, r);
  }
  return map;
}

// Fetch id/name/status/deleted for a set of artist ids. Map id -> row.
async function loadArtistsFor(supabase, ids) {
  const map = new Map();
  const list = [...ids];
  const CHUNK = 300;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, directory_status, deleted")
      .in("id", slice);
    if (error) throw error;
    for (const r of data) map.set(r.id, r);
  }
  return map;
}

async function main() {
  console.log(
    DRY_RUN ? "DRY RUN — no DB writes.\n" : "Copying HÖR links onto surviving artists.\n"
  );
  console.log(`CSV: ${csvPath}\n`);

  const supabase = createSupabase();
  const rows = parseCSV(fs.readFileSync(csvPath, "utf-8"));

  if (rows.length === 0) {
    console.log("No rows found in CSV.");
    return;
  }
  for (const col of ["rule", "artist_id", "matched_artist_id"]) {
    if (!(col in rows[0])) {
      console.error(
        `CSV is missing required column "${col}". Found: ${Object.keys(rows[0]).join(", ")}\n` +
          "Expected a hoer-status-resolution-<stamp>.csv from resolve-hoer-status.mjs."
      );
      process.exit(1);
    }
  }

  // Only the exact-duplicate rows carry a matched artist to copy the link onto.
  const pairs = rows
    .filter((r) => (r.rule ?? "").trim() === "exact_duplicate")
    .map((r) => ({
      dupId: (r.artist_id ?? "").trim(),
      matchedId: (r.matched_artist_id ?? "").trim(),
      hoerName: r.hoer_name ?? "",
      matchedName: r.matched_name ?? "",
    }))
    .filter((p) => p.dupId && p.matchedId);

  if (pairs.length === 0) {
    console.log("No exact_duplicate rows with a matched artist in this CSV — nothing to do.");
    return;
  }
  console.log(`exact_duplicate pairs to process: ${pairs.length}\n`);

  const ids = new Set();
  for (const p of pairs) {
    ids.add(p.dupId);
    ids.add(p.matchedId);
  }
  const hoerLinks = await loadHoerLinksFor(supabase, ids);
  const artists = await loadArtistsFor(supabase, ids);

  const applied = []; // audit rows
  let copied = 0;
  let wouldCopy = 0;
  let skipped = 0;
  let errors = 0;

  // Tracks hoer urls now present on each target (seed from DB, update as we go)
  // so two duplicates pointing at the same survivor behave idempotently within
  // one run. id -> url.
  const targetHoerUrl = new Map();
  for (const [artistId, link] of hoerLinks) targetHoerUrl.set(artistId, link.url ?? "");

  const seenPair = new Set();

  for (const p of pairs) {
    const record = (action, note, url = "") => {
      applied.push({
        artist_id: p.dupId,
        hoer_name: p.hoerName,
        matched_artist_id: p.matchedId,
        matched_name: p.matchedName,
        action,
        url,
        note,
      });
      if (action === "copied") copied++;
      else if (action === "would-copy") wouldCopy++;
      else if (action === "error") errors++;
      else skipped++;
    };

    const pairKey = `${p.dupId}->${p.matchedId}`;
    if (seenPair.has(pairKey)) {
      record("skipped", "duplicate pair row in CSV");
      continue;
    }
    seenPair.add(pairKey);

    if (p.dupId === p.matchedId) {
      record("skipped", "source and target are the same artist");
      continue;
    }

    const target = artists.get(p.matchedId);
    if (!target) {
      record("skipped", "target (matched) artist not found");
      continue;
    }
    if (target.deleted) {
      record("skipped", "target (matched) artist is deleted");
      continue;
    }

    const source = artists.get(p.dupId);
    if (!source) {
      record("skipped", "source (duplicate) artist not found");
      continue;
    }
    if (source.directory_status !== "duplicate") {
      record(
        "skipped",
        `source not marked duplicate (is "${source.directory_status}") — ` +
          "resolution not applied; run the resolver for real first"
      );
      continue;
    }

    const srcLink = hoerLinks.get(p.dupId);
    if (!srcLink) {
      record("skipped", "source has no platform='hoer' link to copy");
      continue;
    }

    const existingTargetUrl = targetHoerUrl.get(p.matchedId);
    if (existingTargetUrl !== undefined) {
      if (existingTargetUrl === (srcLink.url ?? "")) {
        record("skipped", "target already has this hoer link", srcLink.url ?? "");
      } else {
        record(
          "skipped",
          `target already has a DIFFERENT hoer link ("${existingTargetUrl}") — ` +
            "one hoer link per artist; resolve by hand",
          srcLink.url ?? ""
        );
      }
      continue;
    }

    if (DEBUG) {
      console.log(`  copy hoer link ${srcLink.url ?? ""}  ${p.dupId} -> ${p.matchedId}`);
    }

    if (DRY_RUN) {
      record("would-copy", `-> ${p.matchedName}`, srcLink.url ?? "");
      targetHoerUrl.set(p.matchedId, srcLink.url ?? ""); // simulate for idempotency
      continue;
    }

    const { error } = await supabase.from("artist_links").insert({
      artist_id: p.matchedId,
      platform: HOER,
      handle: srcLink.handle ?? null,
      url: srcLink.url ?? null,
      original_url: srcLink.original_url ?? null,
      not_found: srcLink.not_found ?? false,
    });

    if (error) {
      // 23505 = unique_violation: the target sprouted a hoer link since we read.
      if (error.code === "23505") {
        record("skipped", "target already has a hoer link (unique violation on insert)", srcLink.url ?? "");
      } else {
        record("error", error.message, srcLink.url ?? "");
        console.error(`  insert error (${p.matchedId}): ${error.message}`);
      }
      continue;
    }

    targetHoerUrl.set(p.matchedId, srcLink.url ?? "");
    record("copied", `-> ${p.matchedName}`, srcLink.url ?? "");
  }

  console.log(
    DRY_RUN
      ? `\nwould copy: ${wouldCopy}   skipped: ${skipped}   errors: ${errors}\n`
      : `\ncopied: ${copied}   skipped: ${skipped}   errors: ${errors}\n`
  );

  const outPath = path.resolve(process.cwd(), `hoer-link-migration-applied-${timestamp()}.csv`);
  writeCSV(
    outPath,
    ["artist_id", "hoer_name", "matched_artist_id", "matched_name", "action", "url", "note"],
    applied
  );
  console.log(`Wrote audit log:\n  ${outPath}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
