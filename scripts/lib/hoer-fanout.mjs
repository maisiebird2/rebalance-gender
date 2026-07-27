// ============================================================
// Shared DB fan-out for HÖR terms that have just become bound to an artist.
// Used by BOTH seed-hoer-terms.mjs (--backfill-terms) and
// integrate-hoer-artists.mjs (Phase D): in both, a term gains an artist_id
// AFTER its sets were already processed by a normal Phase B run (when it was
// still unbound), so the genres/bio that couldn't be staged then must be
// replayed at bind time.
//
// Idempotent — genres upsert with ignoreDuplicates, bio upserts on
// (artist_id, platform) — so replaying already-staged sets is harmless. This
// is why the derived-collaboration model matters: there is no per-set counter
// to double-apply on replay.
//
// (This is the DB-write counterpart to the pure genreStageRows in hoer-seed.mjs
// — same split as hoer-db.mjs / hoer-resolve.mjs.)
// ============================================================

import { hoerJson } from "./hoer-http.mjs";
import { artistUrl, decodeEntities } from "./hoer-library.mjs";
import { genreStageRows } from "./hoer-seed.mjs";

const CHUNK = 500;
const PAGE_SIZE = 1000;

// Full tag map (tag id -> name). 122 tags, 2 pages, read once per run.
export async function loadTagMap() {
  const map = new Map();
  for (let page = 1; ; page++) {
    const { ok, data } = await hoerJson(`/wp-json/wp/v2/tags?per_page=100&page=${page}&_fields=id,name`);
    if (!ok || !Array.isArray(data) || data.length === 0) break;
    for (const t of data) if (t.id != null && t.name) map.set(t.id, decodeEntities(String(t.name)));
    if (data.length < 100) break;
  }
  return map;
}

// term_id -> { artist_id, bio, slug } for the given term ids that are BOUND
// (artist_id not null). Batched .in().
export async function loadBoundTerms(supabase, termIds) {
  const map = new Map();
  for (let i = 0; i < termIds.length; i += CHUNK) {
    const chunk = termIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("hoer_terms")
      .select("term_id, artist_id, bio, slug")
      .in("term_id", chunk)
      .not("artist_id", "is", null);
    if (error) throw new Error(`couldn't read bound terms: ${error.message}`);
    for (const r of data ?? []) map.set(r.term_id, r);
  }
  return map;
}

// Stage genres + bio for the bound terms among `termIds`, by replaying every
// set that credits them from the ledger (regardless of processed_at). Returns
// { genres, bios, sets }.
export async function stageFanoutForTerms(supabase, termIds, tagMap) {
  const bound = await loadBoundTerms(supabase, termIds);
  if (bound.size === 0) return { genres: 0, bios: 0, sets: 0 };
  const boundIds = [...bound.keys()];

  // Every set crediting any of these terms (processed or not).
  const sets = [];
  for (let i = 0; i < boundIds.length; i += CHUNK) {
    const idChunk = boundIds.slice(i, i + CHUNK);
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("hoer_sets")
        .select("post_id, term_ids, tag_ids")
        .overlaps("term_ids", idChunk)
        .order("post_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`couldn't read sets for fan-out: ${error.message}`);
      sets.push(...(data ?? []));
      if ((data?.length ?? 0) < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  const termToArtist = new Map([...bound].map(([tid, r]) => [tid, r.artist_id]));
  const genreRows = genreStageRows(sets, termToArtist, tagMap);
  let genres = 0;
  for (let i = 0; i < genreRows.length; i += CHUNK) {
    const chunk = genreRows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("artist_harvested_genres")
      .upsert(chunk, { onConflict: "artist_id,source_platform,raw_tag", ignoreDuplicates: true });
    if (error) console.error(`  (genre stage chunk failed: ${error.message})`);
    else genres += chunk.length;
  }

  let bios = 0;
  for (const [, r] of bound) {
    if (!r.bio) continue;
    const src = artistUrl(r.slug);
    const { error: bErr } = await supabase
      .from("biographies")
      .upsert({ artist_id: r.artist_id, platform: "hoer", bio: r.bio, source_url: src }, { onConflict: "artist_id,platform" });
    if (bErr) {
      console.error(`  (bio upsert failed for ${r.artist_id}: ${bErr.message})`);
      continue;
    }
    await supabase
      .from("artist_harvested_bios")
      .upsert(
        { artist_id: r.artist_id, source_platform: "hoer", source_url: src, raw_bio: r.bio },
        { onConflict: "artist_id,source_platform" }
      );
    bios++;
  }
  return { genres, bios, sets: sets.length };
}
