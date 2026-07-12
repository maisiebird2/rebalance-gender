-- Migration: make artist_aliases.name_search strip punctuation as well as
-- spaces, so it stays mirrored with artists.name_search.
-- Run once in the Supabase SQL editor, in a low-traffic window.
--
-- Why:
--
--   supabase_migration_name_search_strip_punctuation.sql switched
--   artists.name_search from
--     lower(replace(immutable_unaccent(name), ' ', ''))
--   to
--     regexp_replace(lower(immutable_unaccent(name)), '[^a-z0-9]', '', 'g')
--   but it did NOT touch artist_aliases.name_search, which was added by
--   supabase_migration_alias_search.sql with the old space-only expression.
--
--   getArtists() (src/lib/queries.ts) normalizes the query once and matches it
--   against BOTH columns, relying on them being identical ("artist_aliases
--   .name_search mirrors artists.name_search"). Once the client-side
--   normalizeSearch() also strips punctuation to match the artists column, an
--   alias whose stored key still kept punctuation (e.g. "A.mo" -> "a.mo")
--   would stop matching. This brings the alias column back in line so the
--   invariant holds and a single normalized term matches both columns.
--
-- Mechanics:
--
--   name_search is a STORED generated column and Postgres can't ALTER a
--   generation expression in place, so it's a drop-and-recreate. The only
--   dependent object is the trigram index idx_artist_aliases_name_search_trgm
--   (from supabase_migration_alias_search.sql), which is dropped first and
--   rebuilt unchanged afterwards.
--
--   lower(), immutable_unaccent(), and regexp_replace(..., 'g') are all
--   IMMUTABLE, so the new expression is valid for a generated column.
--
--   Recreating a STORED column recomputes it for every row — a one-time cost,
--   hence the low-traffic window.

begin;

-- 1. drop the index that depends on the column
drop index if exists "idx_artist_aliases_name_search_trgm";

-- 2. drop and re-add the generated column with the new expression
alter table "public"."artist_aliases" drop column "name_search";
alter table "public"."artist_aliases"
  add column "name_search" text
  generated always as (
    regexp_replace(lower(public.immutable_unaccent(name)), '[^a-z0-9]', '', 'g')
  ) stored;

-- 3. rebuild the trigram index unchanged
create index "idx_artist_aliases_name_search_trgm"
  on "public"."artist_aliases" using gin ("name_search" public.gin_trgm_ops);

commit;
