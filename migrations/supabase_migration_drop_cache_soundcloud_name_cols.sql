-- Migration: drop the TEMPORARY sc_followee-name-backfill `username` column.
-- Run this once in the Supabase SQL editor AFTER
-- scripts/backfill-sc-followee-names.mjs has finished successfully.
--
-- This column (added by supabase_migration_cache_soundcloud_name_cols.sql) only
-- existed to let the backfill read username without detoasting the payload.
-- Nothing else references it. Dropping a generated column is a fast metadata-
-- only operation (no table rewrite).
--
-- NOTE: this does NOT touch `permalink_url` — that generated column is
-- permanent (the SC-followee-duplicates query depends on it). Only `username`
-- is removed here.
--
-- Safe to re-run (IF EXISTS).

ALTER TABLE "public"."api_response_cache"
  DROP COLUMN IF EXISTS "username";
