// ============================================================
// Supabase access layer shared by the HÖR resolver scripts.
//
// scripts/lib/hoer-resolve.mjs deliberately stays DB-free so it can be
// unit-tested; this module is its counterpart — the (untestable-in-sandbox)
// Supabase reads that report-hoer-internal-dupes.mjs and
// resolve-hoer-status.mjs both need. Writes stay in the scripts themselves.
//
// Every table read paginates at the 1000-row PostgREST cap.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_SIZE = 1000;

// ------------------------------------------------------------
// Load .env.local (same shape the other scripts use). Called by the
// scripts before createSupabase().
// ------------------------------------------------------------
export function loadEnvLocal() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(here, "..", "..", ".env.local");
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

export function createSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY. Fill these in in .env.local."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Paginating select-all. `orderCol` must be a UNIQUE ordering so range
// pagination is stable across page boundaries — pass a string for a single
// unique column (defaults to "id") or an array for a composite key
// (artist_genres has no id, so callers pass ["artist_id", "genre_id"]).
export function makeFetchAll(supabase) {
  return async function fetchAll(table, select, applyFilters = (q) => q, orderCol = "id") {
    const orderCols = Array.isArray(orderCol) ? orderCol : [orderCol];
    const all = [];
    let from = 0;
    while (true) {
      let query = supabase.from(table).select(select);
      for (const col of orderCols) query = query.order(col, { ascending: true });
      query = applyFilters(query);
      query = query.range(from, from + PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) throw error;
      all.push(...data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return all;
  };
}

// ------------------------------------------------------------
// Higher-level loaders. Each takes a fetchAll from makeFetchAll().
// ------------------------------------------------------------

// artist_id -> { url, handle, original_url, not_found } for every artist
// carrying a platform='hoer' link. The key set doubles as "which artists came
// from HÖR". The extra fields let the link-migration copy the link faithfully.
export async function loadHoerLinks(fetchAll) {
  const rows = await fetchAll(
    "artist_links",
    "artist_id, url, handle, original_url, not_found",
    (q) => q.eq("platform", "hoer")
  );
  const map = new Map();
  for (const r of rows) {
    // keep the first link per artist (HÖR seeds exactly one)
    if (!map.has(r.artist_id)) {
      map.set(r.artist_id, {
        url: r.url,
        handle: r.handle,
        original_url: r.original_url,
        not_found: r.not_found,
      });
    }
  }
  return map;
}

// All non-deleted artists: id, name, name_search, directory_status, pronoun_id.
export async function loadArtists(fetchAll) {
  return fetchAll(
    "artists",
    "id, name, name_search, directory_status, pronoun_id",
    (q) => q.eq("deleted", false)
  );
}

// artist_id -> array of { platform, bio } across all platforms.
export async function loadBiographies(fetchAll) {
  const rows = await fetchAll("biographies", "artist_id, platform, bio");
  const map = new Map();
  for (const r of rows) {
    if (!r.bio) continue;
    if (!map.has(r.artist_id)) map.set(r.artist_id, []);
    map.get(r.artist_id).push({ platform: r.platform, bio: r.bio });
  }
  return map;
}

// artist_id -> raw_bio for a given harvested source_platform (HÖR fallback).
export async function loadHarvestedBios(fetchAll, sourcePlatform) {
  const rows = await fetchAll("artist_harvested_bios", "artist_id, raw_bio", (q) =>
    q.eq("source_platform", sourcePlatform)
  );
  const map = new Map();
  for (const r of rows) {
    if (r.raw_bio && !map.has(r.artist_id)) map.set(r.artist_id, r.raw_bio);
  }
  return map;
}

// genre_id -> name, for promoted-genre name lookups.
export async function loadGenreNames(fetchAll) {
  const rows = await fetchAll("genres", "id, name");
  const map = new Map();
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

// artist_id -> array of promoted genre names (via artist_genres + genres).
export async function loadPromotedGenres(fetchAll, genreNames) {
  const rows = await fetchAll("artist_genres", "artist_id, genre_id", (q) => q, [
    "artist_id",
    "genre_id",
  ]);
  const map = new Map();
  for (const r of rows) {
    const name = genreNames.get(r.genre_id);
    if (!name) continue;
    if (!map.has(r.artist_id)) map.set(r.artist_id, []);
    map.get(r.artist_id).push(name);
  }
  return map;
}

// artist_id -> array of raw_tag strings for a harvested source_platform.
export async function loadHarvestedGenres(fetchAll, sourcePlatform) {
  const rows = await fetchAll(
    "artist_harvested_genres",
    "artist_id, raw_tag",
    (q) => q.eq("source_platform", sourcePlatform)
  );
  const map = new Map();
  for (const r of rows) {
    if (!r.raw_tag) continue;
    if (!map.has(r.artist_id)) map.set(r.artist_id, []);
    map.get(r.artist_id).push(r.raw_tag);
  }
  return map;
}

export async function loadPronouns(supabase) {
  const { data, error } = await supabase.from("pronouns").select("id, value").order("id");
  if (error) throw error;
  return data ?? [];
}
