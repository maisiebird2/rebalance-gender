-- Migration: api_response_cache.permalink_url generated column
-- Run this once in the Supabase SQL editor.
--
-- Why:
--
--   The sc-followee-duplicates admin report reads only permalink_url out of
--   each soundcloud_user cache row, but that field lives inside the large
--   `payload` JSONB. Selecting it via payload->>'permalink_url' still forces
--   Postgres to detoast the whole payload for every one of the ~135k rows,
--   which dominated the report's runtime (and, before pagination was fixed,
--   tripped statement_timeout).
--
--   A STORED generated column materializes permalink_url as its own small text
--   value alongside the row. Selecting it never touches the TOASTed payload, so
--   the report can read all permalinks without any detoast. Postgres keeps it in
--   sync automatically on every insert/upsert — no write-path change and no
--   backfill script needed; adding the column populates existing rows too.
--
--   jsonb's ->> operator is IMMUTABLE, so it is valid in a generated expression.
--   The column is NULL for namespaces whose payload has no permalink_url (e.g.
--   discogs-artist, lastfm) — harmless, since only soundcloud_user rows read it.
--
-- Note: ADD COLUMN ... GENERATED ... STORED rewrites the table (it detoasts
-- every payload once to compute the stored value) and holds an ACCESS EXCLUSIVE
-- lock for the duration. On this table size that is a short one-off; still,
-- prefer running it during low traffic so the pipeline scripts / app aren't
-- blocked mid-write.
--
-- Apply this BEFORE deploying the updated report route: the route selects the
-- new column, so it must exist first. The column is additive and backward-
-- compatible, so applying it early does not affect any current code.
--
-- Safe to re-run (IF NOT EXISTS).

ALTER TABLE "public"."api_response_cache"
  ADD COLUMN IF NOT EXISTS "permalink_url" text
  GENERATED ALWAYS AS ("payload"->>'permalink_url') STORED;
