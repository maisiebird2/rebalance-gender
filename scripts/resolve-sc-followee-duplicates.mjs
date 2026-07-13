// ============================================================
// Resolve sc_followee duplicates — merge a follow-graph-discovered artist into
// the approved artist it turned out to be, then hard-delete the duplicate.
// ============================================================
//
// find-sc-followee-duplicates.sql surfaces sc_followee artists whose SoundCloud
// profile URL matches a link already held by an approved artist — i.e. the same
// person, found a second time via the follow graph and mistakenly written as a
// brand-new sc_followee. This script does the cleanup that report implies.
//
// For each (sc_followee → approved) match it:
//
//   1. Re-points every sc_follow_edges row that references the followee's id
//      (as follower_artist_id OR followed_artist_id) to the approved artist's
//      id, so the follow relationships the graph discovered are preserved on the
//      real artist. Edges that would become a self-follow (the other endpoint IS
//      the approved artist) or that would duplicate an edge the approved artist
//      already has are left alone — they carry no new information and are removed
//      by the cascade in step 4.
//
//   2. Removes the followee's re-hosted image object(s) from the "artist-images"
//      Storage bucket. The artist_images ROW cascades away when the artist is
//      deleted (step 4), but the Storage object is not governed by the FK, so it
//      would otherwise be orphaned — mirrors prune-artist-images.mjs.
//
//   3. Hard-deletes the followee's api_response_cache rows (keyed by
//      cache_key = artist id, e.g. namespace 'soundcloud_user'). The cache is
//      keyed by text, not an FK, so it is likewise not cascaded.
//
//   4. Hard-deletes the sc_followee artists row. Every other table that
//      references artists(id) does so ON DELETE CASCADE (artist_links,
//      artist_enrichment, biographies, artist_images, genres, aliases,
//      harvest_failures, the remaining sc_follow_edges, …), so this one delete
//      sweeps up everything else. The followee never should have been created as
//      its own artist, so this is a true hard delete, not a soft `deleted` flag.
//
// The match logic mirrors find-sc-followee-duplicates.sql exactly: a followee's
// SoundCloud permalink (api_response_cache.permalink_url, namespace
// 'soundcloud_user', cache_key = artist id) is normalized (scheme + "www."
// stripped, query/fragment dropped, trailing slash removed, lowercased) and
// compared against the same normalization of every approved artist's non-
// not_found artist_links.url. A followee that matches links from two DIFFERENT
// approved artists is ambiguous — we skip it and report it rather than guess.
//
// Every run writes a timestamped CSV report to the working directory (deleted
// artist, retained artist, matched URL, edge counts, per-pair status) so it's
// clear what happened and when — e.g. sc-followee-duplicates-dryrun-<stamp>.csv.
//
// Dry run by default (prints exactly what WOULD change). Pass --apply to write.
// Because the deletes are irreversible, always do a dry run first.
//   node scripts/resolve-sc-followee-duplicates.mjs                 # preview only
//   node scripts/resolve-sc-followee-duplicates.mjs --apply         # execute
//   node scripts/resolve-sc-followee-duplicates.mjs --limit=5       # cap pairs (test)
//   node scripts/resolve-sc-followee-duplicates.mjs --apply --debug # verbose errors
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DEBUG = args.includes("--debug");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

// ------------------------------------------------------------
// Load .env.local (same loader as the other scripts)
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

const BUCKET = "artist-images";
const PAGE_SIZE = 1000;

// ------------------------------------------------------------
// URL normalization — mirrors the regexp chain in
// find-sc-followee-duplicates.sql so both sides match:
//   strip scheme + optional "www.", drop ?query/#fragment, drop trailing
//   slash(es), lowercase.
// ------------------------------------------------------------
function normUrl(u) {
  if (u == null) return null;
  let s = String(u).trim();
  s = s.replace(/^https?:\/\/(www\.)?/i, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

// ------------------------------------------------------------
// CSV report helpers. Every run writes a report named with a local-time
// stamp so it's clear when (and in which mode) it was produced, e.g.
//   sc-followee-duplicates-dryrun-2026-07-13_184205.csv
//   sc-followee-duplicates-applied-2026-07-13_184530.csv
// written to the current working directory.
// ------------------------------------------------------------
function runStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = [
  "deleted_artist_name",
  "deleted_artist_id",
  "retained_artist_name",
  "retained_artist_id",
  "matched_soundcloud_url",
  "follow_edges_total",
  "follow_edges_repointed",
  "follow_edges_cascade_deleted",
  "storage_objects_removed",
  "status",
];

function writeCsv(records) {
  const filename = `sc-followee-duplicates-${APPLY ? "applied" : "dryrun"}-${runStamp()}.csv`;
  const outPath = path.join(process.cwd(), filename);
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of records) {
    lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  }
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");
  return outPath;
}

// Keyset pagination (see backfill-sc-followee-names.mjs for the why). `orderCol`
// must be unique and included in `select`.
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

// ------------------------------------------------------------
// Build the list of (followee → approved) pairs to resolve, exactly as
// find-sc-followee-duplicates.sql would.
// ------------------------------------------------------------
async function findDuplicatePairs() {
  console.log("Loading sc_followee artists…");
  const followees = await fetchAll(
    "artists",
    "id, name",
    (q) => q.eq("directory_status", "sc_followee").eq("deleted", false),
    "id",
  );

  console.log("Loading sc_followee SoundCloud permalinks (api_response_cache)…");
  const cache = await fetchAll(
    "api_response_cache",
    "cache_key, permalink_url",
    (q) => q.eq("namespace", "soundcloud_user").not("permalink_url", "is", null),
    "cache_key",
  );
  const permalinkById = new Map(cache.map((r) => [r.cache_key, r.permalink_url]));

  console.log("Loading approved artists' links…");
  // Every approved, non-deleted artist's real links (not not_found, url set),
  // joined so we can read the artist's status. `id` (the artist_links pk) is the
  // keyset column.
  const links = await fetchAll(
    "artist_links",
    "id, artist_id, url, artists!inner(name, directory_status, deleted)",
    (q) =>
      q
        .eq("artists.directory_status", "approved")
        .eq("artists.deleted", false)
        .eq("not_found", false)
        .not("url", "is", null),
    "id",
  );

  // norm_url → Map(approved_id → approved_name). A Map keyed by id collapses an
  // approved artist that lists the same URL under several platforms to one
  // entry, so those don't read as "ambiguous".
  const approvedByUrl = new Map();
  for (const l of links) {
    const key = normUrl(l.url);
    if (!key) continue;
    let byId = approvedByUrl.get(key);
    if (!byId) {
      byId = new Map();
      approvedByUrl.set(key, byId);
    }
    byId.set(l.artist_id, l.artists?.name ?? l.artist_id);
  }

  const pairs = [];
  const ambiguous = [];
  let noPermalink = 0;
  let noMatch = 0;
  for (const f of followees) {
    const permalink = permalinkById.get(f.id);
    if (!permalink) {
      noPermalink++;
      continue;
    }
    const key = normUrl(permalink);
    const byId = key ? approvedByUrl.get(key) : null;
    if (!byId || byId.size === 0) {
      noMatch++;
      continue;
    }
    // Defensive: a followee should never itself be an approved match.
    byId.delete(f.id);
    if (byId.size === 0) {
      noMatch++;
      continue;
    }
    if (byId.size > 1) {
      ambiguous.push({
        followee: f,
        permalink,
        approvedIds: [...byId.keys()],
        approvedNames: [...byId.values()],
      });
      continue;
    }
    const [approvedId, approvedName] = [...byId.entries()][0];
    pairs.push({
      followeeId: f.id,
      followeeName: f.name,
      followeeUrl: permalink,
      approvedId,
      approvedName,
    });
  }

  pairs.sort((a, b) => a.followeeName.localeCompare(b.followeeName));

  console.log(`\nsc_followees:                         ${followees.length}`);
  console.log(`  without a cached SC permalink:      ${noPermalink}`);
  console.log(`  no approved-artist URL match:       ${noMatch}`);
  console.log(`  ambiguous (>1 approved match):      ${ambiguous.length}`);
  console.log(`  resolvable duplicates:              ${pairs.length}`);

  if (ambiguous.length > 0) {
    console.log(`\n⚠ Skipping ${ambiguous.length} ambiguous followee(s) — same URL on multiple approved artists:`);
    for (const a of ambiguous.slice(0, 20)) {
      console.log(
        `  "${a.followee.name}" (${a.followee.id})\n    ${a.permalink}\n    → ${a.approvedNames
          .map((n, i) => `${n} (${a.approvedIds[i]})`)
          .join(", ")}`,
      );
    }
    if (ambiguous.length > 20) console.log(`  … and ${ambiguous.length - 20} more`);
  }

  return pairs;
}

// ------------------------------------------------------------
// Work out which of the followee's follow edges to re-point vs. leave for the
// cascade. Returns { toUpdate: [{id, column, value}], drop: N }.
//
//   toUpdate — edges safe to move to the approved id (change follower or
//              followed to approved_id) without hitting the self-follow check or
//              the (follower, followed) unique constraint.
//   drop     — edges that would collide/self-follow if moved; they carry no new
//              info (the approved artist already has that edge, or it'd be a
//              self-follow) and get cascade-deleted with the artist.
// ------------------------------------------------------------
async function planEdgeRepoint(followeeId, approvedId) {
  const [asFollower, asFollowed, apAsFollower, apAsFollowed] = await Promise.all([
    supabase
      .from("sc_follow_edges")
      .select("id, followed_artist_id")
      .eq("follower_artist_id", followeeId),
    supabase
      .from("sc_follow_edges")
      .select("id, follower_artist_id")
      .eq("followed_artist_id", followeeId),
    supabase
      .from("sc_follow_edges")
      .select("followed_artist_id")
      .eq("follower_artist_id", approvedId),
    supabase
      .from("sc_follow_edges")
      .select("follower_artist_id")
      .eq("followed_artist_id", approvedId),
  ]);
  for (const r of [asFollower, asFollowed, apAsFollower, apAsFollowed]) {
    if (r.error) throw r.error;
  }

  // What the approved artist already points at / is pointed at by.
  const approvedFollows = new Set(apAsFollower.data.map((r) => r.followed_artist_id));
  const approvedFollowedBy = new Set(apAsFollowed.data.map((r) => r.follower_artist_id));

  const toUpdate = [];
  let drop = 0;

  // followee → X  becomes  approved → X
  for (const e of asFollower.data) {
    const x = e.followed_artist_id;
    if (x === approvedId || approvedFollows.has(x)) {
      drop++; // self-follow or duplicate
    } else {
      toUpdate.push({ id: e.id, column: "follower_artist_id", value: approvedId });
      approvedFollows.add(x);
    }
  }

  // X → followee  becomes  X → approved
  for (const e of asFollowed.data) {
    const x = e.follower_artist_id;
    if (x === approvedId || approvedFollowedBy.has(x)) {
      drop++; // self-follow or duplicate
    } else {
      toUpdate.push({ id: e.id, column: "followed_artist_id", value: approvedId });
      approvedFollowedBy.add(x);
    }
  }

  return { toUpdate, drop, total: asFollower.data.length + asFollowed.data.length };
}

// ------------------------------------------------------------
// Apply one pair: re-point edges, remove Storage objects, delete cache, delete
// the artist. Returns per-pair counts.
// ------------------------------------------------------------
async function resolvePair(pair, plan) {
  // 1. Re-point the safe edges. Each is a keyed single-row update; on the off
  //    chance our pre-check missed a collision, a unique/check violation is
  //    treated as "leave it for the cascade" rather than aborting the pair.
  let moved = 0;
  let leftForCascade = plan.drop;
  for (const u of plan.toUpdate) {
    const { error } = await supabase
      .from("sc_follow_edges")
      .update({ [u.column]: u.value })
      .eq("id", u.id);
    if (error) {
      // 23505 unique_violation, 23514 check_violation → redundant edge.
      if (error.code === "23505" || error.code === "23514") {
        leftForCascade++;
        if (DEBUG) console.error(`    edge ${u.id}: ${error.code}, leaving for cascade`);
      } else {
        throw error;
      }
    } else {
      moved++;
    }
  }

  // 2. Remove re-hosted Storage objects (the rows cascade in step 4).
  const { data: imageRows, error: imgErr } = await supabase
    .from("artist_images")
    .select("storage_path")
    .eq("artist_id", pair.followeeId);
  if (imgErr) throw imgErr;
  const storagePaths = imageRows.map((r) => r.storage_path).filter(Boolean);
  if (storagePaths.length > 0) {
    const { error: storageError } = await supabase.storage.from(BUCKET).remove(storagePaths);
    if (storageError) {
      throw new Error(
        `Storage removal failed for ${pair.followeeId} (${storageError.message}); ` +
          `aborting this pair before deleting the artist.`,
      );
    }
  }

  // 3. Delete the followee's cache rows (keyed by cache_key = artist id).
  const { error: cacheErr } = await supabase
    .from("api_response_cache")
    .delete()
    .eq("cache_key", pair.followeeId);
  if (cacheErr) throw cacheErr;

  // 4. Hard-delete the artist — cascades every remaining referencing row.
  const { error: delErr } = await supabase
    .from("artists")
    .delete()
    .eq("id", pair.followeeId)
    .eq("directory_status", "sc_followee"); // guard: never delete a non-followee
  if (delErr) throw delErr;

  return { moved, leftForCascade, storageRemoved: storagePaths.length };
}

async function main() {
  console.log(APPLY ? "RESOLVING sc_followee duplicates (--apply)\n" : "DRY RUN — no writes (pass --apply to execute)\n");

  const allPairs = await findDuplicatePairs();
  const pairs = LIMIT != null ? allPairs.slice(0, LIMIT) : allPairs;
  if (pairs.length === 0) {
    console.log("\nNothing to resolve.");
    return;
  }
  if (LIMIT != null) console.log(`\n(--limit=${LIMIT}: processing ${pairs.length} of ${allPairs.length})`);

  console.log("\nPlanning edge re-points…");
  let totalMoved = 0;
  let totalCascade = 0;
  let totalStorage = 0;
  let done = 0;
  let failed = 0;
  const records = []; // one row per pair for the CSV report

  for (const pair of pairs) {
    // Base CSV row shared by every outcome for this pair.
    const row = {
      deleted_artist_name: pair.followeeName,
      deleted_artist_id: pair.followeeId,
      retained_artist_name: pair.approvedName,
      retained_artist_id: pair.approvedId,
      matched_soundcloud_url: pair.followeeUrl,
      follow_edges_total: "",
      follow_edges_repointed: "",
      follow_edges_cascade_deleted: "",
      storage_objects_removed: "",
      status: "",
    };
    records.push(row);

    let plan;
    try {
      plan = await planEdgeRepoint(pair.followeeId, pair.approvedId);
    } catch (err) {
      failed++;
      row.status = `failed: planning — ${err.message}`;
      console.error(`  ✗ "${pair.followeeName}" (${pair.followeeId}): planning failed — ${err.message}`);
      continue;
    }

    row.follow_edges_total = plan.total;
    row.follow_edges_repointed = plan.toUpdate.length;
    row.follow_edges_cascade_deleted = plan.drop;

    const summary =
      `"${pair.followeeName}" → "${pair.approvedName}"  ` +
      `[${plan.total} edge(s): ${plan.toUpdate.length} move, ${plan.drop} cascade]`;

    if (!APPLY) {
      row.status = "would-resolve";
      console.log(`  would resolve: ${summary}`);
      totalMoved += plan.toUpdate.length;
      totalCascade += plan.drop;
      done++;
      continue;
    }

    try {
      const res = await resolvePair(pair, plan);
      // Reflect what actually happened (a pre-check miss can shift a move to
      // the cascade, so re-read from the result rather than the plan).
      row.follow_edges_repointed = res.moved;
      row.follow_edges_cascade_deleted = res.leftForCascade;
      row.storage_objects_removed = res.storageRemoved;
      row.status = "resolved";
      totalMoved += res.moved;
      totalCascade += res.leftForCascade;
      totalStorage += res.storageRemoved;
      done++;
      console.log(
        `  ✓ ${summary}` +
          (res.storageRemoved ? ` +${res.storageRemoved} img` : ""),
      );
    } catch (err) {
      failed++;
      row.status = `failed: ${err.message}`;
      console.error(`  ✗ ${summary}\n     ${err.message}`);
      if (DEBUG) console.error(err);
    }
  }

  const csvPath = writeCsv(records);

  console.log(`\n${APPLY ? "Done." : "Dry run complete."}`);
  console.log(`  pairs ${APPLY ? "resolved" : "resolvable"}:        ${done}${failed ? `  (failed: ${failed})` : ""}`);
  console.log(`  follow edges re-pointed:   ${totalMoved}`);
  console.log(`  follow edges cascade-gone: ${totalCascade}`);
  if (APPLY) console.log(`  storage objects removed:   ${totalStorage}`);
  console.log(`\nCSV report: ${csvPath}`);
  if (!APPLY) console.log(`Re-run with --apply to execute. This hard-deletes the ${done} followee(s) — irreversible.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
