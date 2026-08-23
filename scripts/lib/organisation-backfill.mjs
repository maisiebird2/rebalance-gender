// ============================================================
// Pure logic for the artist_labels -> organisations backfill.
//
// scripts/migrate-labels-to-organisations.mjs is the Supabase half:
// reads, writes, CSVs. Everything here is DB-free so it can be unit
// tested (organisation-backfill.test.mjs) — the same split
// hoer-resolve.mjs / hoer-db.mjs uses.
//
// The job: 314 artist_labels rows plus 93 comma-separated legacy
// artists.labels strings name roughly 208 distinct organisations. Group
// them by normalised name, pick one surface form to be canonical, and
// flag everything a human should look at before any of it is approved.
// ============================================================

import { normalizeName, nameSimilarity } from "./hoer-resolve.mjs";

// Re-exported so the script and the tests share one normaliser. It
// mirrors the name_search generated column character for character, so
// a group key computed here equals the key Postgres computes for the
// organisation row it creates.
export { normalizeName };

// ------------------------------------------------------------
// Legacy artists.labels is a single text column holding a
// comma-separated list ("UMAY, BPitch Control"). artist_labels is the
// row-per-label replacement; both are read, because 93 artists still
// carry only the old column.
//
// Splits on commas and semicolons only. Slashes and ampersands are NOT
// separators here — "R&S Records" and "Live From Earth / Klub" are
// single names as often as they are two, so those go to the ambiguity
// report for a human instead of being guessed at.
// ------------------------------------------------------------
export function splitLegacyLabels(value) {
  if (typeof value !== "string") return [];
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ------------------------------------------------------------
// Choose the surface form that becomes organisations.name.
//
// Most-used form wins ("BPitch Control" x39 beats a lone "bpitch
// control"). Ties break towards the form that looks hand-typed rather
// than mangled: mixed case first ("Ostgut Ton" over both "OSTGUT TON"
// and "ostgut ton"), then any capital at all, then lexicographically so
// the result never depends on Map iteration order.
// ------------------------------------------------------------
const isMixedCase = (name) => /[a-z]/.test(name) && /[A-Z]/.test(name);

export function pickCanonicalName(surfaceForms) {
  return [...surfaceForms]
    .sort(
      (a, b) =>
        b.count - a.count ||
        Number(isMixedCase(b.name)) - Number(isMixedCase(a.name)) ||
        Number(/[A-Z]/.test(b.name)) - Number(/[A-Z]/.test(a.name)) ||
        a.name.localeCompare(b.name),
    )[0]?.name ?? "";
}

// ------------------------------------------------------------
// Group raw (artistId, rawName) pairs by normalised name.
//
// entries: [{ artistId, rawName, source }] — source is 'artist_labels'
//          or 'artists.labels', kept for the audit CSV.
//
// Returns { groups, unnamed }:
//   groups   Map key -> { key, canonicalName, surfaceForms, entries }
//   unnamed  entries whose name normalises to nothing (punctuation
//            only). There is no organisation there, but they are handed
//            back rather than silently dropped so the report can say so.
// ------------------------------------------------------------
export function groupOrganisations(entries) {
  const groups = new Map();
  const unnamed = [];

  for (const entry of entries) {
    const key = normalizeName(entry.rawName ?? "");
    if (!key) {
      unnamed.push(entry);
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { key, canonicalName: "", surfaceForms: [], entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }

  for (const group of groups.values()) {
    const counts = new Map();
    for (const e of group.entries) {
      const form = (e.rawName ?? "").trim();
      counts.set(form, (counts.get(form) ?? 0) + 1);
    }
    group.surfaceForms = [...counts].map(([name, count]) => ({ name, count }));
    group.canonicalName = pickCanonicalName(group.surfaceForms);
  }

  return { groups, unnamed };
}

// ------------------------------------------------------------
// Flag 1 — names that look like two organisations in one field.
//
// A comma or semicolon has already been split on, so anything left is a
// separator we deliberately refused to guess at: " / ", " & ", " + ",
// " x ". Spaces are required around & and + so "R&S Records" and
// "Nu+Ra" stay single names; a slash needs no spaces because "label/
// club" is written both ways and neither reading is safe to assume.
// ------------------------------------------------------------
const SEPARATOR_RE = /\/|\s&\s|\s\+\s|\sx\s/i;

export function hasSeparator(name) {
  return SEPARATOR_RE.test(name ?? "");
}

// ------------------------------------------------------------
// Flag 2 — a pronoun typed into the label field ("she/they").
//
// Token-based so it stands alone in tests; the script additionally
// passes the normalised values of the `pronouns` table as
// `knownPronouns`, which catches any wording the token list misses.
// ------------------------------------------------------------
const PRONOUN_TOKENS = new Set([
  "she", "her", "hers",
  "he", "him", "his",
  "they", "them", "their", "theirs",
  "it", "its",
  "xe", "xem", "xyr",
  "ze", "zir", "hir",
  "fae", "faer",
  "ey", "em", "eir",
  "any", "all", "none", "pronouns", "no",
]);

/**
 * How a label name matches pronoun data, or null if it doesn't.
 *
 *   "tokens"      every word is a pronoun ("she/they") — somebody typed
 *                 their pronouns into the label field.
 *   "vocabulary"  it only matches a row in the `pronouns` table. That
 *                 usually means the PRONOUNS row is the mistake, not
 *                 this one: production currently has a pronouns row
 *                 reading "BØX collectif", which is an organisation
 *                 name typed into the pronouns field. Worth reporting,
 *                 but it points the other way.
 */
export function pronounMatch(name, knownPronouns = new Set()) {
  const raw = (name ?? "").trim();
  if (!raw) return null;
  const tokens = raw.toLowerCase().split(/[/,\s|]+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((t) => PRONOUN_TOKENS.has(t))) return "tokens";
  if (knownPronouns.has(normalizeName(raw))) return "vocabulary";
  return null;
}

export function looksLikePronouns(name, knownPronouns = new Set()) {
  return pronounMatch(name, knownPronouns) !== null;
}

// ------------------------------------------------------------
// Flag 3 — near-duplicate normalisations.
//
// Exact duplicates already collapsed into one group by construction, so
// what is left are the pairs a human has to judge: "ostgutton" vs
// "ostguttonberlin", "dnbgirls" vs "dnbgirlsuk". Trigram similarity
// from hoer-resolve.mjs, the same measure the HÖR duplicate reports
// use.
//
// O(n^2) over ~208 groups is ~21k comparisons — not worth blocking on.
// ------------------------------------------------------------
export function findNearDuplicates(groups, { threshold = 0.6 } = {}) {
  const list = [...groups.values()];
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const similarity = nameSimilarity(list[i].key, list[j].key);
      if (similarity >= threshold) {
        pairs.push({ a: list[i], b: list[j], similarity });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

// ------------------------------------------------------------
// Flag 4 — the organisation name is also an artist name.
//
// Discwoman and UMAY are the real cases: the person and the thing they
// run share a name, so the two rows are both correct and the reviewer
// needs to see them side by side rather than merge them.
//
// artistsByKey: Map name_search -> [{ id, name, directory_status }]
// ------------------------------------------------------------
// Statuses that mean "a person the directory actually lists". Everything
// else (sc_followee, obscure, label_etc, ...) is an unreviewed import,
// and a name match against one of those usually means the organisation
// itself was imported as an artist rather than that a person and an
// organisation share a name.
const DIRECTORY_ARTIST_STATUSES = new Set(["approved", "pending", "unverified"]);

export function findArtistNameCollisions(groups, artistsByKey) {
  const collisions = [];
  for (const group of groups.values()) {
    const artists = artistsByKey.get(group.key);
    if (artists?.length) collisions.push({ group, artists });
  }
  return collisions;
}

// ------------------------------------------------------------
// Everything a reviewer should see, in one pass over the groups.
// Shape is deliberately flat — it goes straight into the ambiguity CSV.
// ------------------------------------------------------------
export function buildAmbiguityReport(groups, { artistsByKey = new Map(), knownPronouns = new Set(), threshold = 0.6 } = {}) {
  const rows = [];

  for (const group of groups.values()) {
    for (const form of group.surfaceForms) {
      const pronouns = pronounMatch(form.name, knownPronouns);
      if (pronouns) {
        rows.push({
          reason: pronouns === "tokens" ? "pronouns_in_label" : "matches_pronoun_row",
          organisation: group.canonicalName,
          key: group.key,
          detail:
            pronouns === "tokens"
              ? form.name
              : `${form.name} — also a row in the pronouns table; check which field is wrong`,
          artist_count: new Set(group.entries.map((e) => e.artistId)).size,
        });
      } else if (hasSeparator(form.name)) {
        rows.push({
          reason: "separator_in_name",
          organisation: group.canonicalName,
          key: group.key,
          detail: form.name,
          artist_count: new Set(group.entries.map((e) => e.artistId)).size,
        });
      }
    }

    // More than one surface form means the canonical pick discarded a
    // spelling somebody typed; show what was dropped.
    if (group.surfaceForms.length > 1) {
      rows.push({
        reason: "multiple_surface_forms",
        organisation: group.canonicalName,
        key: group.key,
        detail: group.surfaceForms
          .map((f) => `${f.name} (${f.count})`)
          .join(" | "),
        artist_count: new Set(group.entries.map((e) => e.artistId)).size,
      });
    }
  }

  for (const { group, artists } of findArtistNameCollisions(groups, artistsByKey)) {
    // Split by whether the colliding artist is actually in the directory.
    // Both matter, but they are different decisions: an approved artist
    // sharing a name (Discwoman, UMAY) means the person and the thing
    // they run are two correct rows, while a match against an
    // unreviewed import usually means the organisation is already in
    // `artists` under the wrong kind of row. Reporting them under one
    // reason buries the handful that need judgement under a hundred
    // that need the same mechanical fix.
    const inDirectory = artists.some((a) => DIRECTORY_ARTIST_STATUSES.has(a.directory_status));
    rows.push({
      reason: inDirectory ? "name_collides_with_artist" : "name_matches_unreviewed_artist",
      organisation: group.canonicalName,
      key: group.key,
      detail: artists.map((a) => `${a.name} [${a.directory_status}] ${a.id}`).join(" | "),
      artist_count: new Set(group.entries.map((e) => e.artistId)).size,
    });
  }

  for (const { a, b, similarity } of findNearDuplicates(groups, { threshold })) {
    rows.push({
      reason: "near_duplicate",
      organisation: a.canonicalName,
      key: a.key,
      detail: `${b.canonicalName} (${b.key}) — similarity ${similarity.toFixed(2)}`,
      artist_count: new Set(a.entries.map((e) => e.artistId)).size,
    });
  }

  // Highest-signal reasons first, so the two rows that need a judgement
  // call aren't below a hundred that need the same mechanical fix.
  const order = [
    "pronouns_in_label",
    "matches_pronoun_row",
    "separator_in_name",
    "name_collides_with_artist",
    "near_duplicate",
    "multiple_surface_forms",
    "name_matches_unreviewed_artist",
  ];
  return rows.sort(
    (a, b) =>
      order.indexOf(a.reason) - order.indexOf(b.reason) ||
      a.organisation.localeCompare(b.organisation),
  );
}
