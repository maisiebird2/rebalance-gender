-- Extend directory search to match artist aliases, not just the primary name.
--
-- getArtists() previously matched only artists.name_search. To also match on
-- aliases (an artist may have several), we give artist_aliases the same
-- normalized search column the artists table uses, plus a trigram index so the
-- alias lookup is as cheap as the name lookup.
--
-- name_search mirrors artists.name_search exactly:
--   lower(replace(immutable_unaccent(name), ' ', ''))
-- so a term normalized once (client- or server-side) matches both columns.
--
-- Run in the Supabase SQL editor (or psql). Safe to re-run.

-- 1. Normalized, accent-/space-insensitive search column on aliases.
ALTER TABLE "public"."artist_aliases"
  ADD COLUMN IF NOT EXISTS "name_search" "text"
  GENERATED ALWAYS AS (
    "lower"("replace"("public"."immutable_unaccent"("name"), ' '::"text", ''::"text"))
  ) STORED;

-- 2. Trigram GIN index so `name_search ILIKE '%term%'` on aliases uses an
--    index scan instead of seq-scanning every alias row.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_artist_aliases_name_search_trgm
  ON "public"."artist_aliases"
  USING gin ("name_search" "public"."gin_trgm_ops");

-- idx_artist_aliases_artist (btree on artist_id) already exists and covers the
-- lookup of artist_ids once alias rows are matched.
