// ============================================================
// Match Discogs artists against the artists table, in two steps.
//
// Written for export-discogs-label.mjs, which pulls a label's roster off
// Discogs and needs to know which of those artists we already hold. The
// two steps, in order, are:
//
//   1. LINK. The artist's Discogs profile is already on an artist_links
//      row (platform='discogs'). Matched on the NUMERIC Discogs artist
//      id parsed out of both URLs rather than on the strings, because
//      the stored URLs are not normalized: the table holds
//      /artist/21748 alongside /artist/5119514-Amelie-Lens and
//      /fr/artist/10587874-Audrey-Danza, and all three would fail a
//      string compare against the canonical URL Discogs returns.
//
//   2. NAME. The Discogs name, normalized the way the artists.name_search
//      generated column normalizes ours, equals a row's name_search.
//      normalizeName() (scripts/lib/hoer-resolve.mjs) is defined to
//      mirror that column's expression character-for-character, so this
//      is an equality test on the DB's own key, not a fuzzy match.
//
// Step 2 only ever runs for artists step 1 didn't match — a Discogs link
// is identity, a name is an inference, so the identity wins.
//
// AMBIGUITY IS NOT A MATCH. ~5,000 name_search keys are shared by more
// than one live artist (Tino, DNA, Noname, ...), and duplicate rows can
// carry the same Discogs link too. Where more than one live artist
// answers, the result is reported as ambiguous with its candidates
// attached and NO artist chosen: picking one would quietly attach a
// release to the wrong person, and the caller can list them for a human
// instead.
//
// Soft-deleted artists (deleted = true) are invisible to both steps.
// ============================================================

import { normalizeName } from "./hoer-resolve.mjs";

// PostgREST puts .in() lists in the query string, so they are chunked to
// keep the URL a sane length.
const IN_CHUNK = 150;

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * The numeric Discogs artist id in a URL, or null.
 *
 * Same shape sync-discogs.mjs matches: /artist/127045,
 * /artist/127045-Aleja-Sanchez, and a locale prefix like /de/ or /fr/.
 * Old-format links carry a name instead of an id
 * (/artist/Bruno+Pronsato) and return null — there are ~1,700 rows on
 * platform='discogs' that aren't numeric artist URLs at all (label
 * pages, user pages, a bare /search/), and every one of them has to
 * stay out of the id index.
 */
export function discogsArtistIdFromUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const m = rawUrl.match(/discogs\.com\/(?:[a-z]{2}\/)?artist\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Index artist_links rows by Discogs artist id.
 *
 * @param   {Array<{artist_id: string, url: string}>} rows
 * @returns {Map<string, string[]>}  discogs id -> artist_ids, deduped
 */
export function buildDiscogsIdIndex(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    const discogsId = discogsArtistIdFromUrl(row?.url);
    if (!discogsId || !row.artist_id) continue;
    const existing = index.get(discogsId);
    if (existing) {
      if (!existing.includes(row.artist_id)) existing.push(row.artist_id);
    } else {
      index.set(discogsId, [row.artist_id]);
    }
  }
  return index;
}

/**
 * Turn a candidate list into a result: exactly one live artist is a
 * match, several are an ambiguity, none is nothing.
 *
 * @param {Array<{id: string, name: string}>} candidates
 * @param {"link"|"name"} via
 */
export function decide(candidates, via) {
  if (candidates.length === 1) {
    return { method: via, id: candidates[0].id, name: candidates[0].name, candidates };
  }
  if (candidates.length > 1) {
    return { method: `${via}_ambiguous`, id: null, name: null, candidates };
  }
  return { method: null, id: null, name: null, candidates: [] };
}

/**
 * Match Discogs artists against the database.
 *
 * @param {object} params
 * @param {Function} params.fetchAll  from makeFetchAll() in hoer-db.mjs
 * @param {Array<{key: string, name: string, discogsId: string|number|null}>} params.artists
 *   the distinct Discogs artists to look up. `key` is the caller's own
 *   identifier for the artist and is what the returned map is keyed by.
 * @returns {Promise<Map<string, {method: string|null, id: string|null, name: string|null, candidates: Array<{id: string, name: string}>}>>}
 */
export async function matchDiscogsArtists({ fetchAll, artists }) {
  const results = new Map();

  // ── Step 1: the Discogs link ───────────────────────────────
  // not_found rows are excluded: those record "we looked and there is
  // no Discogs page for this artist", so their URL is a rejected guess
  // rather than a claim of identity.
  const linkRows = await fetchAll("artist_links", "artist_id, url", (q) =>
    q.eq("platform", "discogs").eq("not_found", false)
  );
  const idIndex = buildDiscogsIdIndex(linkRows);

  const linkedArtistIds = new Set();
  for (const artist of artists) {
    const discogsId = artist.discogsId ? String(artist.discogsId) : null;
    for (const id of (discogsId && idIndex.get(discogsId)) || []) linkedArtistIds.add(id);
  }
  const liveById = await loadArtistsByIds(fetchAll, [...linkedArtistIds]);

  const unmatched = [];
  for (const artist of artists) {
    const discogsId = artist.discogsId ? String(artist.discogsId) : null;
    const candidates = ((discogsId && idIndex.get(discogsId)) || [])
      .map((id) => liveById.get(id))
      .filter(Boolean);
    const decided = decide(candidates, "link");
    results.set(artist.key, decided);
    if (!decided.method) unmatched.push(artist);
  }

  // ── Step 2: the normalized name ────────────────────────────
  const keysByName = new Map(); // name_search key -> [artist keys]
  for (const artist of unmatched) {
    const nameKey = normalizeName(artist.name);
    if (!nameKey) continue;
    const existing = keysByName.get(nameKey);
    if (existing) existing.push(artist.key);
    else keysByName.set(nameKey, [artist.key]);
  }

  const byNameKey = new Map(); // name_search key -> [{id, name}]
  for (const keys of chunk([...keysByName.keys()], IN_CHUNK)) {
    const rows = await fetchAll("artists", "id, name, name_search", (q) =>
      q.in("name_search", keys).eq("deleted", false)
    );
    for (const row of rows) {
      const existing = byNameKey.get(row.name_search);
      if (existing) existing.push({ id: row.id, name: row.name });
      else byNameKey.set(row.name_search, [{ id: row.id, name: row.name }]);
    }
  }

  for (const [nameKey, artistKeys] of keysByName) {
    const decided = decide(byNameKey.get(nameKey) ?? [], "name");
    if (!decided.method) continue;
    for (const key of artistKeys) results.set(key, decided);
  }

  return results;
}

/** id -> {id, name} for the live (non-deleted) artists among `ids`. */
async function loadArtistsByIds(fetchAll, ids) {
  const byId = new Map();
  for (const batch of chunk(ids, IN_CHUNK)) {
    const rows = await fetchAll("artists", "id, name", (q) =>
      q.in("id", batch).eq("deleted", false)
    );
    for (const row of rows) byId.set(row.id, { id: row.id, name: row.name });
  }
  return byId;
}
