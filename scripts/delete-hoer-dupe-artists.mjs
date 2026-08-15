#!/usr/bin/env node
// ============================================================
// delete-hoer-dupe-artists.mjs — hard-delete the artists left behind by
// duplicate resolution: rows whose platform='hoer' artist_links URL is shared
// with at least one other artist AND whose directory_status is 'duplicate'.
//
// migrate-hoer-dupe-links.mjs copies each duplicate's HÖR link onto its
// surviving artist, so after that migration the 'duplicate' rows are pure
// leftovers — same URL, out of the directory. This script removes them.
//
// Selection: all platform='hoer' links are grouped by url; for every url held
// by 2+ artists, the sharers with directory_status='duplicate' are candidates.
//
// Guards (a candidate is skipped + logged, never forced):
//   - the url has NO surviving sharer (every sharer is itself 'duplicate' or
//     soft-deleted) -> skip all of them; deleting would erase the HÖR
//     association entirely. Needs a human.
//   - artist row missing (already gone)              -> skip
//   - artist soft-deleted (deleted = true)           -> skip; soft-deleted rows
//     are kept as records, same as the migration treats its sources
//
// Delete order (matches apply-pending-hoer-decisions.mjs):
//   1. unbind hoer_terms rows pointing at the delete set — the FK is ON DELETE
//      SET NULL, but hoer_terms_bound_consistency requires artist_id,
//      bind_method and bound_at to be null together
//   2. delete the artists; artist_links / biographies / images cascade, and
//      any duplicate_of references to them go ON DELETE SET NULL
//
// Writes hoer-dupe-artist-delete-<stamp>.csv recording every candidate.
//
// Usage (from the repo root):
//   node scripts/delete-hoer-dupe-artists.mjs           # dry run (default)
//   node scripts/delete-hoer-dupe-artists.mjs --apply   # delete for real
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import path from "node:path";
import { loadEnvLocal, createSupabase, makeFetchAll } from "./lib/hoer-db.mjs";
import { writeCSV, timestamp } from "./lib/hoer-resolve.mjs";
import { outputPath } from "./lib/output-path.mjs";
import { HOER } from "./lib/hoer-links.mjs";

const APPLY = process.argv.includes("--apply");

loadEnvLocal();

const AUDIT_COLUMNS = ["artist_id", "name", "directory_status", "url", "action", "note"];

// Fetch id/name/directory_status/deleted for a set of artist ids, chunked so
// the .in() list never gets unwieldy. Map id -> row.
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
    APPLY
      ? "APPLY — hard-deleting duplicate-status artists with shared HÖR links.\n"
      : "DRY RUN — no DB writes. Pass --apply to delete for real.\n"
  );

  const supabase = createSupabase();
  const fetchAll = makeFetchAll(supabase);

  // Every hoer link, grouped by url. The (artist_id, platform) unique
  // constraint means each artist appears at most once.
  const links = await fetchAll("artist_links", "artist_id, url", (q) => q.eq("platform", HOER));
  const byUrl = new Map();
  for (const l of links) {
    const url = (l.url ?? "").trim();
    if (!url) continue;
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(l.artist_id);
  }

  const sharedUrls = [...byUrl.entries()].filter(([, ids]) => ids.length > 1);
  console.log(`hoer links: ${links.length}   shared urls: ${sharedUrls.length}\n`);

  if (sharedUrls.length === 0) {
    console.log("No duplicated HÖR urls — nothing to do.");
    return;
  }

  const involvedIds = new Set(sharedUrls.flatMap(([, ids]) => ids));
  const artists = await loadArtistsFor(supabase, involvedIds);

  const audit = [];
  const toDelete = [];

  for (const [url, ids] of sharedUrls) {
    const sharers = ids.map((id) => ({ id, row: artists.get(id) }));

    const survivors = sharers.filter(
      (s) => s.row && !s.row.deleted && s.row.directory_status !== "duplicate"
    );

    for (const s of sharers) {
      const record = (action, note) => {
        audit.push({
          artist_id: s.id,
          name: s.row?.name ?? "",
          directory_status: s.row?.directory_status ?? "",
          url,
          action,
          note,
        });
      };

      if (!s.row) {
        record("skipped", "artist row not found (already deleted?)");
        continue;
      }
      if (s.row.deleted) {
        record("skipped", "artist is soft-deleted; left as a record");
        continue;
      }
      if (s.row.directory_status !== "duplicate") {
        record("kept", "survivor — not marked duplicate");
        continue;
      }
      if (survivors.length === 0) {
        record(
          "skipped",
          "no surviving sharer for this url (all duplicates/soft-deleted) — needs a human"
        );
        continue;
      }

      toDelete.push(s.id);
      record(
        APPLY ? "deleted" : "would-delete",
        `survivor: ${survivors.map((v) => v.row.name).join("; ")}`
      );
    }
  }

  const wouldDelete = toDelete.length;
  console.log(`${APPLY ? "deleting" : "would delete"}: ${wouldDelete} artists`);

  if (APPLY && toDelete.length > 0) {
    // hoer_terms' FK is ON DELETE SET NULL, but hoer_terms_bound_consistency
    // requires artist_id, bind_method and bound_at to be null together — fully
    // unbind the terms first so the artist delete can proceed.
    for (let i = 0; i < toDelete.length; i += 100) {
      const { error } = await supabase
        .from("hoer_terms")
        .update({ artist_id: null, bind_method: null, bound_at: null })
        .in("artist_id", toDelete.slice(i, i + 100));
      if (error) throw new Error(`unbind hoer_terms: ${error.message}`);
    }
    console.log("  hoer_terms unbound for the delete set");

    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += 50) {
      const { data, error } = await supabase
        .from("artists")
        .delete()
        .in("id", toDelete.slice(i, i + 50))
        .select("id");
      if (error) throw new Error(`hard delete: ${error.message}`);
      deleted += data.length;
    }
    console.log(`  hard deleted: ${deleted} artists`);
  }

  const skipped = audit.filter((a) => a.action === "skipped").length;
  const kept = audit.filter((a) => a.action === "kept").length;
  console.log(`kept (survivors): ${kept}   skipped: ${skipped}`);

  const outPath = outputPath(`hoer-dupe-artist-delete-${timestamp()}.csv`);
  writeCSV(outPath, AUDIT_COLUMNS, audit);
  console.log(`\nWrote audit log:\n  ${outPath}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
