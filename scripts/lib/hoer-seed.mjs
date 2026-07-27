// ============================================================
// Pure, DB-free helpers for the HÖR term seeder
// (seed-hoer-terms.mjs — Phase B of the rework; see
// scripts/HOER-SYNC-REWORK-PLAN.md).
//
// Deterministic and side-effect-free so it can be unit-tested without a
// database or the network (see hoer-seed.test.mjs). The script owns the
// Supabase reads/writes and the (fallback-only) HÖR API calls; this module
// owns the shaping of a set's `authors` payload into hoer_terms rows and of a
// set's tags into staged genre rows. Same split as hoer-library.mjs.
// ============================================================

import { decodeEntities } from "./hoer-library.mjs";

// Trim → null: collapse empty / whitespace-only strings to null so we never
// store "" in a name column.
function orNull(s) {
  const t = s == null ? "" : String(s).trim();
  return t === "" ? null : t;
}

// A bio may arrive with WP markup and entities. Strip tags, decode entities,
// normalize whitespace. Empty → null.
export function cleanBio(raw) {
  if (raw == null) return null;
  const text = decodeEntities(
    String(raw)
      .replace(/\r\n?/g, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
  return text || null;
}

// Shape one post `authors[]` entry into a hoer_terms UPSERT payload.
//
// CRITICAL: this returns ONLY identity / name / bio fields + last_seen_at. It
// deliberately omits artist_id, bound_at, bind_method, scraped_at, image_url
// and first_seen_at, so upserting an existing term refreshes its names/bio and
// bumps last_seen_at WITHOUT disturbing a binding Phase D set or a portrait
// Phase C scraped. (A brand-new row gets those columns' defaults: null / now().)
//
// Returns null for an author with no usable term_id or slug.
export function termUpsertFromAuthor(author, seenAtIso) {
  if (author == null) return null;
  const termId = author.term_id;
  const slug = orNull(author.slug);
  if (termId == null || !Number.isFinite(Number(termId)) || slug == null) return null;
  return {
    term_id: Number(termId),
    slug,
    display_name: orNull(author.display_name),
    first_name: orNull(author.first_name),
    last_name: orNull(author.last_name),
    bio: cleanBio(author.description),
    wp_user_id: author.user_id ? Number(author.user_id) : null,
    is_guest: author.is_guest == null ? null : Boolean(Number(author.is_guest)),
    last_seen_at: seenAtIso,
  };
}

// Shape a ppma_author term (the fallback path — a set whose `authors` array is
// absent) into the same payload shape. That endpoint gives only id/slug/name,
// so display_name is best-effort from `name` and first/last/bio are null.
export function termUpsertFromPpmaTerm(term, seenAtIso) {
  if (term == null) return null;
  const slug = orNull(term.slug);
  if (term.id == null || slug == null) return null;
  return {
    term_id: Number(term.id),
    slug,
    display_name: orNull(term.name),
    first_name: null,
    last_name: null,
    bio: null,
    wp_user_id: null,
    is_guest: null,
    last_seen_at: seenAtIso,
  };
}

// Every distinct term id referenced across a batch of sets (each set's
// `term_ids` int[]). Order-preserving.
export function distinctTermIds(sets) {
  const seen = new Set();
  const out = [];
  for (const s of sets) {
    for (const tid of Array.isArray(s.term_ids) ? s.term_ids : []) {
      if (tid == null || seen.has(tid)) continue;
      seen.add(tid);
      out.push(tid);
    }
  }
  return out;
}

// term_id -> author object, first occurrence across the batch that carries a
// slug. The source for term seeding; term ids present in `term_ids` but absent
// here are the fallback set (resolve via the ppma_author API).
export function buildAuthorIndex(sets) {
  const index = new Map();
  for (const s of sets) {
    for (const a of Array.isArray(s.authors) ? s.authors : []) {
      if (a?.term_id == null || index.has(a.term_id)) continue;
      if (!a.slug) continue;
      index.set(a.term_id, a);
    }
  }
  return index;
}

// Staged genre rows for the BOUND terms in a batch: one row per
// (artist_id, raw_tag). A set's tags apply to every bound artist credited on
// that set. `termToArtist` is term_id -> artist_id (bound terms only);
// `tagMap` is tag_id -> name. Deduped across the whole batch.
export function genreStageRows(sets, termToArtist, tagMap) {
  const byKey = new Map();
  for (const s of sets) {
    const tagIds = Array.isArray(s.tag_ids) ? s.tag_ids : [];
    if (tagIds.length === 0) continue;
    const artistIds = new Set();
    for (const tid of Array.isArray(s.term_ids) ? s.term_ids : []) {
      const artistId = termToArtist.get(tid);
      if (artistId) artistIds.add(artistId);
    }
    if (artistIds.size === 0) continue;
    const rawTags = [];
    for (const tagId of tagIds) {
      const raw = (tagMap.get(tagId) ?? "").toLowerCase().trim();
      if (raw) rawTags.push(raw);
    }
    for (const artistId of artistIds) {
      for (const raw of rawTags) {
        const key = `${artistId}|${raw}`;
        if (byKey.has(key)) continue;
        byKey.set(key, { artist_id: artistId, source_platform: "hoer", raw_tag: raw });
      }
    }
  }
  return [...byKey.values()];
}

// Slug from a HÖR /artist/<slug>/ URL — the backfill-terms fallback when an
// artist_links row has no `handle`. Lowercased; null if not an artist URL.
export function slugFromArtistUrl(url) {
  const m = String(url ?? "").match(/\/artist\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}
