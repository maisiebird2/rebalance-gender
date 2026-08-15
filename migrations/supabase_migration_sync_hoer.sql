-- Migration: hoer_sync_state — sync-hoer's incremental set cursor.
-- Run once in the Supabase SQL editor before running scripts/sync-hoer.mjs.
--
-- (HÖR's private legal names go to the shared artist_legal_names table —
-- see supabase_migration_artist_legal_names.sql, which sync-hoer and
-- sync-discogs both write to. This file only adds the cursor.)
--
-- Why:
--
--   hoer_sync_state is a one-row table holding the newest HÖR set (post)
--   date sync-hoer has processed. sync-hoer crawls
--   /wp-json/wp/v2/posts?after=<cursor> so each run only ingests sets
--   published since the last run (genres beget artist_harvested_genres
--   rows; a shared set begets a collaborations edge whose collab_count
--   must not be double-counted on re-runs). Keeping the cursor in the
--   DB — not a cache file — is the project rule.
--
-- Single row, enforced by a boolean PK fixed to true. last_set_date is
-- the max post `date` (WordPress publishes these in the site's local
-- time, no zone; sync-hoer stores/compares them as ISO strings and
-- passes them straight back as the REST `after` param).
--
-- Internal state, same posture as resolved_artists / harvest_failures /
-- artist_legal_names: RLS on, no anon/authenticated read policy;
-- service_role (the secret key sync-hoer uses) bypasses RLS.
--
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS "public"."hoer_sync_state" (
    "id"            boolean NOT NULL DEFAULT true,
    "last_set_date" "text",
    "updated_at"    timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hoer_sync_state_singleton" CHECK ("id" = true),
    CONSTRAINT "hoer_sync_state_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."hoer_sync_state" OWNER TO "postgres";

ALTER TABLE "public"."hoer_sync_state" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."hoer_sync_state" TO "service_role";
