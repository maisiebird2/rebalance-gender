-- Migration: make artists.name_search strip punctuation as well as spaces.
-- Run once in the Supabase SQL editor, in a low-traffic window.
--
-- Why:
--
--   name_search has until now been
--     lower(replace(immutable_unaccent(name), ' ', ''))
--   i.e. it lowercases, strips diacritics, and removes spaces — but KEEPS
--   punctuation. That means "A.M.", "A M" and "AM" all produce different
--   search keys, so it can't be used as a clean normalized-name key for
--   exact-duplicate matching.
--
--   This is a long-intended change: switch the expression to remove every
--   character that isn't [a-z0-9], so name_search becomes a punctuation- and
--   space-free normalized key. After this, the HÖR status resolver
--   (scripts/resolve-hoer-status.mjs) can match on name_search directly, and
--   scripts/lib/hoer-resolve.mjs's normalizeName() mirrors this exact
--   expression so DB and script agree character-for-character.
--
-- Mechanics:
--
--   name_search is a STORED generated column and Postgres can't ALTER a
--   generation expression in place, so it's a drop-and-recreate. The only
--   dependent object is the partial trigram index
--   idx_artists_name_search_trgm_approved (verified against the schema dump),
--   which is dropped first and rebuilt unchanged afterwards.
--
--   lower(), immutable_unaccent(), and regexp_replace(..., 'g') are all
--   IMMUTABLE, so the new expression is valid for a generated column.
--
--   Recreating a STORED column recomputes it for every row — a one-time cost,
--   hence the low-traffic window.
--
-- After running: re-dump the schema (supabase_schema_current.sql / schema.sql)
-- so the checked-in DDL reflects the new generation expression.

begin;

-- 1. drop the index that depends on the column
drop index if exists "idx_artists_name_search_trgm_approved";

-- 2. drop and re-add the generated column with the new expression
alter table "public"."artists" drop column "name_search";
alter table "public"."artists"
  add column "name_search" text
  generated always as (
    regexp_replace(lower(public.immutable_unaccent(name)), '[^a-z0-9]', '', 'g')
  ) stored;

-- 3. rebuild the partial trigram index unchanged
create index "idx_artists_name_search_trgm_approved"
  on "public"."artists" using gin ("name_search" public.gin_trgm_ops)
  where (("directory_status" = 'approved'::"public"."artist_status")
         and ("deleted" = false));

commit;
