#!/usr/bin/env node
// ============================================================
// soft-delete-single-link-dupes.mjs — soft-delete the artist rows that exist
// only to hold a link an approved artist already has.
//
// An artist qualifies when BOTH hold:
//   1. it has exactly ONE artist_links row, and
//   2. a different, live (deleted = false) artist holds that same link — same
//      platform, same url under the repo's URL-sameness rule (scheme / www /
//      trailing-slash / tracking-param insensitive; see
//      scripts/lib/link-url-match.mjs) — AND that other row beats this one.
//
// Such a row carries nothing the approved artist doesn't: same platform
// association, no other links. Soft delete (artists.deleted = true) is the
// same operation the admin UI's "delete artist" performs — the row stays as a
// record, so hoer_terms bindings, duplicate_of references and the links
// themselves are all left intact and the decision is reversible.
//
// Runs across EVERY platform by default. --platform=<name> narrows the
// candidates to stubs on one platform; the approved sharer is matched on the
// same platform either way, so a Bandcamp link never justifies deleting a
// SoundCloud stub.
//
// "Beats this one" is a dominance test on two things — whether the row is
// approved, and how many links it holds. A sharer wins when it is at least as
// good on both and strictly better on at least one:
//
//   sharer approved, candidate not      -> delete; a directory entry beats a
//                                          row outside the directory
//   same status tier, sharer has more   -> delete; the fuller row is the real
//                                          entry, this is the stub beside it
//
// Clearing those pairs — the same artist twice over, once as a bare stub — is
// the main thing this script is for.
//
// Neither signal alone is decisive. An approved row holding one link is NOT
// deleted for a not_eligible row holding six: the approved row is the only
// one of the pair the public site shows, so deleting it would drop the artist
// from the directory while the fuller data sits on a row nobody can see.
//
// Flagged for a human, never guessed (all logged to the CSV):
//   - an exact tie: same status tier, both holding just the one link
//   - candidate approved, sharer fuller but not in the directory -> a merge
//   - the candidate is already soft-deleted, or its artist row is missing
//
// A candidate that beats every sharer outright is the survivor, and is simply
// kept — silently, with no CSV row. So is a stub whose only sharer is
// soft-deleted: a deleted row is not a survivor and cannot justify anything.
//
// The selection itself is pure and unit-tested — see
// scripts/lib/single-link-dupes.mjs and its .test.mjs.
//
// Writes single-link-dupe-soft-delete[-<platform>]-<stamp>.csv to the output
// folder, recording every artist soft-deleted plus every candidate skipped
// and why.
//
// Usage (from the repo root):
//   node scripts/soft-delete-single-link-dupes.mjs                        # dry run, all platforms
//   node scripts/soft-delete-single-link-dupes.mjs --platform=hoer        # dry run, one platform
//   node scripts/soft-delete-single-link-dupes.mjs --apply                # soft-delete for real
//   node scripts/soft-delete-single-link-dupes.mjs --platform=soundcloud --apply
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { loadEnvLocal, createSupabase, makeFetchAll } from "./lib/hoer-db.mjs";
import { writeCSV, timestamp } from "./lib/hoer-resolve.mjs";
import { outputPath } from "./lib/output-path.mjs";
import {
  selectSingleLinkDupeSoftDeletes,
  SOFT_DELETE_AUDIT_COLUMNS,
} from "./lib/single-link-dupes.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

// --platform=<name>, or null for every platform.
const platformArg = args.find((a) => a.startsWith("--platform="));
const PLATFORM = platformArg ? platformArg.slice("--platform=".length).trim() : null;

const unknownArgs = args.filter((a) => a !== "--apply" && !a.startsWith("--platform="));
if (unknownArgs.length > 0) {
  console.error(`Unrecognised argument(s): ${unknownArgs.join(", ")}`);
  console.error("Usage: node scripts/soft-delete-single-link-dupes.mjs [--platform=<name>] [--apply]");
  process.exit(1);
}
if (platformArg && !PLATFORM) {
  console.error("--platform= needs a value, e.g. --platform=soundcloud");
  process.exit(1);
}

loadEnvLocal();

// Fetch id/name/directory_status/deleted for a set of artist ids, chunked so
// the .in() list never gets unwieldy. Map id -> row.
async function loadArtistsFor(supabase, ids) {
  const map = new Map();
  const list = [...ids];
  const CHUNK = 300;
  for (let i = 0; i < list.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, directory_status, deleted")
      .in("id", list.slice(i, i + CHUNK));
    if (error) throw new Error(`load artists: ${error.message}`);
    for (const row of data) map.set(row.id, row);
  }
  return map;
}

// A typo'd platform would otherwise look exactly like "nothing to do", so
// check it against the lookup table artist_links.platform references.
async function assertKnownPlatform(supabase, platform) {
  const { data, error } = await supabase.from("platforms").select("key").order("key");
  if (error) throw new Error(`load platforms: ${error.message}`);
  const known = data.map((row) => row.key);
  if (!known.includes(platform)) {
    throw new Error(
      `Unknown platform "${platform}". Known platforms:\n  ${known.join(", ")}`
    );
  }
}

async function main() {
  const scope = PLATFORM ? `platform '${PLATFORM}'` : "all platforms";
  console.log(
    APPLY
      ? `APPLY — soft-deleting single-link artists whose link an approved artist holds (${scope}).\n`
      : `DRY RUN — no DB writes, ${scope}. Pass --apply to soft-delete for real.\n`
  );

  const supabase = createSupabase();
  const fetchAll = makeFetchAll(supabase);

  if (PLATFORM) await assertKnownPlatform(supabase, PLATFORM);

  // Every link, all platforms, even when --platform narrows the candidates:
  // the other-platform rows are what prove an artist is NOT a single-link
  // stub, so they can never be filtered out server-side.
  const links = await fetchAll("artist_links", "artist_id, platform, url");
  const artists = await loadArtistsFor(supabase, new Set(links.map((l) => l.artist_id)));
  console.log(`artist_links: ${links.length}   artists with links: ${artists.size}\n`);

  const { toSoftDelete, audit } = selectSingleLinkDupeSoftDeletes({
    links,
    artists,
    platform: PLATFORM,
  });

  const skipped = audit.filter((row) => row.action === "skipped");
  console.log(`${APPLY ? "soft-deleting" : "would soft-delete"}: ${toSoftDelete.length} artists`);
  console.log(`skipped (logged, needs a human or already done): ${skipped.length}`);

  // Per-platform breakdown — the point of the all-platforms default is seeing
  // where the stubs actually are.
  const byPlatform = new Map();
  for (const row of audit) {
    let counts = byPlatform.get(row.platform);
    if (!counts) {
      counts = { deleting: 0, skipped: 0 };
      byPlatform.set(row.platform, counts);
    }
    if (row.action === "skipped") counts.skipped += 1;
    else counts.deleting += 1;
  }
  if (byPlatform.size > 0) {
    console.log("\n  platform          to delete   skipped");
    const sorted = [...byPlatform.entries()].sort((a, b) => b[1].deleting - a[1].deleting);
    for (const [platform, counts] of sorted) {
      console.log(
        `  ${platform.padEnd(16)}  ${String(counts.deleting).padStart(9)}   ${String(counts.skipped).padStart(7)}`
      );
    }
  }

  if (APPLY && toSoftDelete.length > 0) {
    let done = 0;
    for (let i = 0; i < toSoftDelete.length; i += 50) {
      const { data, error } = await supabase
        .from("artists")
        .update({ deleted: true })
        .in("id", toSoftDelete.slice(i, i + 50))
        .select("id");
      if (error) throw new Error(`soft delete: ${error.message}`);
      done += data.length;
    }
    console.log(`\n  soft-deleted: ${done} artists`);
  }

  // The CSV records what actually happened, so the action column only claims
  // a deletion on an --apply run.
  for (const row of audit) {
    if (row.action === "to-soft-delete") {
      row.action = APPLY ? "soft-deleted" : "would-soft-delete";
    }
  }

  const suffix = PLATFORM ? `-${PLATFORM}` : "";
  const outPath = outputPath(`single-link-dupe-soft-delete${suffix}-${timestamp()}.csv`);
  writeCSV(outPath, SOFT_DELETE_AUDIT_COLUMNS, audit);
  console.log(`\nWrote audit log:\n  ${outPath}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
