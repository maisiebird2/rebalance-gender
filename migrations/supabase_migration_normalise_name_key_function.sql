-- Migration: give the name_search key ONE definition — normalise_name_key().
-- Run once in the Supabase SQL editor, in a low-traffic window.
--
-- Why:
--
--   The normalised name key
--     regexp_replace(lower(public.immutable_unaccent(name)), '[^a-z0-9]', '', 'g')
--   was written out inline in three generated columns (artists.name_search,
--   artist_aliases.name_search, organisations.name_search) and approximated
--   in JavaScript in five more places. Nothing enforced that the copies
--   agreed, and they had already drifted: the app's JS version relied on NFD
--   decomposition, which cannot see the diacritic inside a precomposed
--   codepoint, so a directory search for "ØTTA" normalised to "tta" and
--   returned every artist with those letters anywhere in their name, while
--   the stored key was the correct "otta".
--
--   This migration puts the expression in a function and has all three
--   columns call it. After this there is exactly one copy in the database,
--   and src/lib/name-key.mjs is the one copy in the application — generated
--   from this function's behaviour by scripts/generate-unaccent-delta.mjs
--   and checked against it by src/lib/name-key.test.ts.
--
--   The computed values do not change. This is a refactor of where the
--   expression lives, not of what it produces, so no row's name_search
--   differs afterwards and no re-matching is needed.
--
-- Mechanics:
--
--   A generated column's expression must be IMMUTABLE. lower(),
--   immutable_unaccent() and regexp_replace(..., 'g') all are, so a SQL
--   function wrapping them can be too. It is schema-qualified throughout and
--   deliberately has no SET search_path clause: that would block inlining,
--   and the qualification already makes it unambiguous.
--
--   Postgres cannot ALTER a generation expression in place, so each column is
--   a drop-and-recreate, and every index on it has to be dropped first and
--   rebuilt after. Recreating a STORED column recomputes it for every row —
--   a one-time cost, hence the low-traffic window.
--
--   artists.name_search and organisations.name_search carry COLUMN-LEVEL
--   SELECT grants (supabase_migration_artists_private_columns.sql and
--   supabase_migration_organisations.sql: both tables have private columns,
--   so there is no table-level SELECT to fall back on). A recreated column
--   loses its grant, and a role needs SELECT on a column to use it in a
--   WHERE clause even when the column is never returned — so without the
--   re-grants at the end of this script, directory search returns nothing for
--   anonymous visitors. artist_aliases has table-level grants and needs no
--   such repair.
--
-- After running:
--   - npm run check-artists-column-grants   (confirms the artists re-grant)
--   - npm test                              (the DB-parity test in
--                                            src/lib/name-key.test.ts)
--   - re-dump the schema so the checked-in DDL shows the new expressions.

begin;

-- 1. the single definition
create or replace function "public"."normalise_name_key"("value" "text")
returns "text"
language sql
immutable
parallel safe
returns null on null input
as $$
  select "regexp_replace"("lower"("public"."immutable_unaccent"("value")), '[^a-z0-9]', '', 'g')
$$;

comment on function "public"."normalise_name_key"("text") is
  'The normalised name key: strip diacritics, lowercase, keep only [a-z0-9]. '
  'Generates name_search on artists, artist_aliases and organisations. '
  'Mirrored in JavaScript by src/lib/name-key.mjs — change the two together.';

-- 2. drop the indexes that depend on the columns
drop index if exists "public"."idx_artists_name_search_trgm_approved";
drop index if exists "public"."idx_artist_aliases_name_search_trgm";
drop index if exists "public"."idx_organisations_name_search";
drop index if exists "public"."idx_organisations_name_search_trgm";

-- 3. repoint each generated column at the function
alter table "public"."artists" drop column "name_search";
alter table "public"."artists"
  add column "name_search" "text"
  generated always as ("public"."normalise_name_key"("name")) stored;

alter table "public"."artist_aliases" drop column "name_search";
alter table "public"."artist_aliases"
  add column "name_search" "text"
  generated always as ("public"."normalise_name_key"("name")) stored;

alter table "public"."organisations" drop column "name_search";
alter table "public"."organisations"
  add column "name_search" "text"
  generated always as ("public"."normalise_name_key"("name")) stored;

-- 4. rebuild the indexes exactly as they were
create index "idx_artists_name_search_trgm_approved"
  on "public"."artists" using gin ("name_search" "public"."gin_trgm_ops")
  where (("directory_status" = 'approved'::"public"."artist_status")
         and ("deleted" = false));

create index "idx_artist_aliases_name_search_trgm"
  on "public"."artist_aliases" using gin ("name_search" "public"."gin_trgm_ops");

create index "idx_organisations_name_search"
  on "public"."organisations" using btree ("name_search");

create index "idx_organisations_name_search_trgm"
  on "public"."organisations" using gin ("name_search" "public"."gin_trgm_ops");

-- 5. restore the column grants the drop took away (see the header)
grant select ("name_search") on table "public"."artists"       to "anon", "authenticated";
grant select ("name_search") on table "public"."organisations" to "anon", "authenticated";

commit;
