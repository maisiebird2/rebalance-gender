#!/usr/bin/env node
// ============================================================
// Backfill: artist_labels (flat strings) -> organisations (real rows)
//
// Phase 2 of documentation/PROPOSAL-organisations.md. Run
// migrations/supabase_migration_organisations.sql first.
//
// What it does
//
//   Pass 1  Reads the artist_labels rows and comma-splits the legacy
//           artists.labels strings, groups them by normalised name,
//           creates one PENDING organisation per group, and attaches
//           each artist with role_key = 'associated' — which is exactly
//           what today's flat text means.
//
//   Pass 2  Takes the artists sitting at directory_status='label_etc'
//           (organisations that were submitted as artists), name-matches
//           them to an organisation from pass 1, ports their
//           artist_links into organisation_links, and marks the artist
//           row deleted. An unmatched one becomes a new pending
//           organisation rather than being dropped. --skip-label-etc
//           runs pass 1 alone.
//
// What it does NOT do
//
//   artist_labels and artists.labels are left untouched — the read path
//   dual-reads during the transition and the old columns go in phase 8.
//   Nothing gets a type, location or link automatically either; that is
//   the hand work the admin panel exists for.
//
//   Nothing is published: every organisation is created 'pending', so
//   the junk row, the near-duplicates and the artist/organisation name
//   collisions all get seen before anything reaches the public site.
//
// Idempotent. An organisation whose name_search already exists is
// reused rather than duplicated, and the associations are upserted, so
// a second --apply after a partial failure finishes the job instead of
// doubling it.
//
// Dry-run unless --apply is given. Either way it writes three CSVs to
// the output folder (see documentation/OUTPUT-FILE-LOCATION.md):
//
//   organisations-plan-<stamp>.csv        one row per organisation
//   organisations-ambiguity-<stamp>.csv   what a human must decide
//   organisations-label-etc-<stamp>.csv   pass 2's actions
//
// Usage (from the repo root):
//
//   npm run migrate-labels-to-organisations
//   npm run migrate-labels-to-organisations -- --apply
//   npm run migrate-labels-to-organisations -- --apply --skip-label-etc
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createSupabase, loadEnvLocal, makeFetchAll } from "./lib/hoer-db.mjs";
import { outputPath } from "./lib/output-path.mjs";
import { writeCSV, timestamp } from "./lib/hoer-resolve.mjs";
import {
  splitLegacyLabels,
  groupOrganisations,
  buildAmbiguityReport,
  normalizeName,
} from "./lib/organisation-backfill.mjs";

const APPLY = process.argv.includes("--apply");
const SKIP_LABEL_ETC = process.argv.includes("--skip-label-etc");

// The role every backfilled association gets. Seeded by the migration;
// see §2 of the proposal for why it is the right default.
const DEFAULT_ROLE = "associated";
const INSERT_CHUNK = 500;

loadEnvLocal();
const supabase = createSupabase();
const fetchAll = makeFetchAll(supabase);
const stamp = timestamp();

const log = (...args) => console.log(...args);

function chunk(rows, size = INSERT_CHUNK) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function insertChunked(table, rows, options) {
  for (const batch of chunk(rows)) {
    const query = options
      ? supabase.from(table).upsert(batch, options)
      : supabase.from(table).insert(batch);
    const { error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

// A dry run is useful BEFORE the migration has been applied — it is how
// you find out how many organisations you are about to create and what
// needs deciding first. So a missing organisations table is reported and
// treated as empty here, and only refused under --apply.
let migrationApplied = true;

async function fetchAllOptional(table, select, applyFilters, orderCol) {
  try {
    return await fetchAll(table, select, applyFilters, orderCol);
  } catch (err) {
    // PostgREST reports an unknown table as PGRST205 and Postgres as
    // 42P01, depending on which layer notices first.
    const code = err?.code ?? "";
    const message = String(err?.message ?? err);
    if (code === "42P01" || code === "PGRST205" || /does not exist|find the table/i.test(message)) {
      migrationApplied = false;
      return [];
    }
    throw err;
  }
}

// ------------------------------------------------------------
// Read everything up front. All of it is small (hundreds of rows).
// ------------------------------------------------------------
async function loadState() {
  const [labelRows, artistRows, pronounRows, existingOrgs, existingAssociations] =
    await Promise.all([
      fetchAll("artist_labels", "id, artist_id, name"),
      fetchAll("artists", "id, name, name_search, directory_status, deleted, labels"),
      fetchAll("pronouns", "id, value"),
      fetchAllOptional("organisations", "id, name, name_search, status"),
      fetchAllOptional("artist_organisations", "artist_id, organisation_id, role_key", (q) => q, [
        "artist_id",
        "organisation_id",
        "role_key",
      ]),
    ]);
  return { labelRows, artistRows, pronounRows, existingOrgs, existingAssociations };
}

// artists.name_search is Postgres-computed and therefore authoritative;
// normalizeName() is only the fallback for a row that somehow has none.
const artistKey = (artist) => artist.name_search || normalizeName(artist.name);

async function main() {
  log(`${APPLY ? "APPLY" : "DRY RUN"} — artist_labels -> organisations\n`);

  const state = await loadState();
  if (!migrationApplied) {
    const notice =
      "  organisations table not found — run migrations/supabase_migration_organisations.sql first";
    if (APPLY) {
      console.error(notice.trim());
      process.exit(1);
    }
    log(`${notice}\n  continuing the dry run against an empty target\n`);
  }
  const artistsById = new Map(state.artistRows.map((a) => [a.id, a]));

  // ── Pass 1: group the flat strings ───────────────────────────────

  const entries = [];
  for (const row of state.labelRows) {
    entries.push({ artistId: row.artist_id, rawName: row.name, source: "artist_labels" });
  }
  for (const artist of state.artistRows) {
    for (const name of splitLegacyLabels(artist.labels)) {
      entries.push({ artistId: artist.id, rawName: name, source: "artists.labels" });
    }
  }

  const { groups, unnamed } = groupOrganisations(entries);
  log(`  ${state.labelRows.length} artist_labels rows`);
  log(`  ${entries.length - state.labelRows.length} names from the legacy artists.labels column`);
  log(`  ${groups.size} distinct organisations after normalisation`);
  if (unnamed.length) {
    log(`  ${unnamed.length} row(s) whose name is punctuation only — skipped`);
  }

  // ── The ambiguity report ─────────────────────────────────────────

  const artistsByKey = new Map();
  for (const artist of state.artistRows) {
    if (artist.deleted) continue;
    const key = artistKey(artist);
    if (!key) continue;
    if (!artistsByKey.has(key)) artistsByKey.set(key, []);
    artistsByKey.get(key).push(artist);
  }

  const knownPronouns = new Set(
    state.pronounRows.map((p) => normalizeName(p.value ?? "")).filter(Boolean),
  );

  const ambiguity = buildAmbiguityReport(groups, { artistsByKey, knownPronouns });
  const ambiguityFile = writeCSV(
    outputPath(`organisations-ambiguity-${stamp}.csv`),
    ["reason", "organisation", "key", "detail", "artist_count"],
    ambiguity,
  );
  log(`  ${ambiguity.length} thing(s) to review -> ${ambiguityFile}`);

  // ── Decide what to create ────────────────────────────────────────

  // Reuse an organisation that already carries the same normalised key,
  // whatever its status — that is what makes a re-run idempotent, and
  // what stops a rejected organisation from quietly coming back.
  const orgByKey = new Map();
  for (const org of state.existingOrgs) {
    const key = org.name_search || normalizeName(org.name);
    if (key && !orgByKey.has(key)) orgByKey.set(key, org);
  }

  const toCreate = [];
  const planRows = [];
  for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const existing = orgByKey.get(group.key);
    const artistIds = [...new Set(group.entries.map((e) => e.artistId))];
    if (!existing) toCreate.push(group);
    planRows.push({
      action: existing ? "reuse_existing" : "create",
      name: existing ? existing.name : group.canonicalName,
      key: group.key,
      status: existing ? existing.status : "pending",
      organisation_id: existing?.id ?? "",
      artist_count: artistIds.length,
      mention_count: group.entries.length,
      surface_forms: group.surfaceForms.map((f) => `${f.name} (${f.count})`).join(" | "),
      artists: artistIds
        .map((id) => artistsById.get(id)?.name ?? id)
        .sort((a, b) => a.localeCompare(b))
        .join(" | "),
    });
  }

  const planFile = writeCSV(
    outputPath(`organisations-plan-${stamp}.csv`),
    [
      "action", "name", "key", "status", "organisation_id",
      "artist_count", "mention_count", "surface_forms", "artists",
    ],
    planRows,
  );
  log(`  ${toCreate.length} to create, ${groups.size - toCreate.length} already present -> ${planFile}`);

  // ── Write pass 1 ─────────────────────────────────────────────────

  if (APPLY && toCreate.length) {
    // Insert without .select(): the ids come back from the read-back
    // below, which also picks up anything a previous partial run left.
    await insertChunked(
      "organisations",
      toCreate.map((group) => ({ name: group.canonicalName, status: "pending" })),
    );
    log(`  created ${toCreate.length} organisation(s)`);

    const created = await fetchAll("organisations", "id, name, name_search, status");
    for (const org of created) {
      const key = org.name_search || normalizeName(org.name);
      if (key && !orgByKey.has(key)) orgByKey.set(key, org);
    }
  }

  // Associations, for the organisations that exist by now. In a dry run
  // that is only the pre-existing ones, so the count is reported as a
  // plan rather than written.
  const seenAssociation = new Set(
    state.existingAssociations.map((a) => `${a.artist_id}|${a.organisation_id}|${a.role_key}`),
  );
  const associations = [];
  for (const group of groups.values()) {
    const org = orgByKey.get(group.key);
    if (!org) continue; // dry run: not created yet
    for (const artistId of new Set(group.entries.map((e) => e.artistId))) {
      const dedupeKey = `${artistId}|${org.id}|${DEFAULT_ROLE}`;
      if (seenAssociation.has(dedupeKey)) continue;
      seenAssociation.add(dedupeKey);
      associations.push({
        artist_id: artistId,
        organisation_id: org.id,
        role_key: DEFAULT_ROLE,
      });
    }
  }

  if (APPLY) {
    if (associations.length) {
      await insertChunked("artist_organisations", associations, {
        onConflict: "artist_id,organisation_id,role_key",
        ignoreDuplicates: true,
      });
    }
    log(`  linked ${associations.length} artist(s) to organisations as '${DEFAULT_ROLE}'`);
  } else {
    const planned = [...groups.values()].reduce(
      (n, g) => n + new Set(g.entries.map((e) => e.artistId)).size,
      0,
    );
    log(`  would link ~${planned} artist-organisation pair(s) as '${DEFAULT_ROLE}'`);
  }

  // ── Pass 2: the label_etc artists ────────────────────────────────

  if (SKIP_LABEL_ETC) {
    log("\n  --skip-label-etc: leaving the label_etc artists alone");
  } else {
    await migrateLabelEtcArtists({ state, orgByKey });
  }

  log(`\n${APPLY ? "Done." : "Dry run — nothing was written. Re-run with --apply."}`);
}

// ------------------------------------------------------------
// Pass 2. An artist at directory_status='label_etc' is an organisation
// somebody submitted through the artist form. It becomes an
// organisation row (matched by name where one already exists), its
// links come with it, and the artist row is soft-deleted so it stops
// appearing in artist tooling.
//
// Soft delete, not a real one: `deleted = true` is reversible, and the
// artist_labels rows pointing at it are still needed until phase 8.
// ------------------------------------------------------------
async function migrateLabelEtcArtists({ state, orgByKey }) {
  const candidates = state.artistRows.filter(
    (a) => a.directory_status === "label_etc" && !a.deleted,
  );
  log(`\n  ${candidates.length} artist(s) at directory_status='label_etc'`);
  if (!candidates.length) return;

  const links = await fetchAll(
    "artist_links",
    "artist_id, platform, handle, url, original_url, not_found",
    (q) => q.in("artist_id", candidates.map((a) => a.id)),
    ["artist_id", "platform"],
  );
  const linksByArtist = new Map();
  for (const link of links) {
    if (!linksByArtist.has(link.artist_id)) linksByArtist.set(link.artist_id, []);
    linksByArtist.get(link.artist_id).push(link);
  }

  const rows = [];
  const toCreate = [];
  for (const artist of candidates) {
    const key = artistKey(artist);
    const matched = key ? orgByKey.get(key) : undefined;
    if (!matched) toCreate.push({ artist, key });
    rows.push({
      artist_id: artist.id,
      artist_name: artist.name,
      key,
      match: matched ? "matched_existing" : "create_organisation",
      organisation_id: matched?.id ?? "",
      organisation_name: matched?.name ?? artist.name,
      link_count: (linksByArtist.get(artist.id) ?? []).length,
      links: (linksByArtist.get(artist.id) ?? [])
        .map((l) => `${l.platform}=${l.url ?? l.handle ?? ""}`)
        .join(" | "),
      artist_marked_deleted: APPLY ? "yes" : "planned",
    });
  }

  const file = writeCSV(
    outputPath(`organisations-label-etc-${stamp}.csv`),
    [
      "artist_id", "artist_name", "key", "match", "organisation_id",
      "organisation_name", "link_count", "links", "artist_marked_deleted",
    ],
    rows,
  );
  log(`  ${toCreate.length} need a new organisation, ${candidates.length - toCreate.length} match one -> ${file}`);

  if (!APPLY) return;

  if (toCreate.length) {
    await insertChunked(
      "organisations",
      toCreate.map(({ artist }) => ({ name: artist.name, status: "pending" })),
    );
    const created = await fetchAll("organisations", "id, name, name_search, status");
    for (const org of created) {
      const key = org.name_search || normalizeName(org.name);
      if (key && !orgByKey.has(key)) orgByKey.set(key, org);
    }
    log(`  created ${toCreate.length} organisation(s) from label_etc artists`);
  }

  // Port the links. organisation_links is unique on
  // (organisation_id, platform), so a platform the organisation already
  // has keeps the link it has — the existing row was curated, this one
  // is a byproduct of the artist row.
  const linkRows = [];
  for (const artist of candidates) {
    const org = orgByKey.get(artistKey(artist));
    if (!org) continue;
    for (const link of linksByArtist.get(artist.id) ?? []) {
      linkRows.push({
        organisation_id: org.id,
        platform: link.platform,
        handle: link.handle,
        url: link.url,
        original_url: link.original_url,
        not_found: link.not_found,
      });
    }
  }
  if (linkRows.length) {
    await insertChunked("organisation_links", linkRows, {
      onConflict: "organisation_id,platform",
      ignoreDuplicates: true,
    });
    log(`  ported ${linkRows.length} link(s) into organisation_links`);
  }

  for (const batch of chunk(candidates.map((a) => a.id))) {
    const { error } = await supabase.from("artists").update({ deleted: true }).in("id", batch);
    if (error) throw new Error(`artists: ${error.message}`);
  }
  log(`  marked ${candidates.length} label_etc artist row(s) deleted`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
