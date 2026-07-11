-- Migration: move artist_enrichment.raw_data → api_response_cache, then drop it
-- Run once in the Supabase SQL editor.
--
-- Why:
--
--   artist_enrichment.raw_data holds the full raw API/page payload per
--   enrichment row (SoundCloud /resolve user, Bandcamp scraped page fields).
--   It is written by sync-soundcloud.mjs, sync-bandcamp.mjs, and
--   build-soundcloud-follow-graph.mjs, and read only by the ad-hoc diagnostic
--   scripts/find-sc-followee-duplicates.sql — never by the app. Leaving it in
--   artist_enrichment has two concrete costs:
--     - the website selects artist_enrichment(*), dragging the unused blob over
--       the wire on every artist page load; and
--     - build-soundcloud-follow-graph.mjs must chunk inserts to 50 rows because
--       the per-row blob makes larger requests drop the Supabase connection.
--
--   That blob is exactly api_response_cache's contract (re-fetchable archival,
--   "safe to delete, we'd just re-fetch"), so it moves there. The three writers
--   now upsert into api_response_cache directly (namespaces 'soundcloud_user' /
--   'bandcamp_page', cache_key = artist_id); this migration copies the EXISTING
--   blobs over before dropping the column, and find-sc-followee-duplicates.sql
--   is updated to read the SoundCloud permalink from the cache instead.
--
--   Keyed by artist_id (not the platform's numeric id) so the mapping is 1:1
--   with the enrichment row it replaces and any reader reconnects trivially.
--   Namespace carries the platform, so an artist's SoundCloud and Bandcamp
--   blobs don't collide on the same cache_key.
--
-- Requires: api_response_cache must already exist
--   (supabase_migration_api_response_cache.sql).
--
-- Idempotent: the copy is guarded on the column still existing, and the drop is
-- IF EXISTS, so re-running after the column is gone is a no-op.

-- 1. Copy existing blobs into api_response_cache. Guarded so a second run (after
--    the column has been dropped) doesn't fail on a missing column reference.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'artist_enrichment'
      AND column_name = 'raw_data'
  ) THEN
    EXECUTE $copy$
      INSERT INTO public.api_response_cache (namespace, cache_key, payload, fetched_at)
      SELECT
        CASE ae.platform
          WHEN 'soundcloud' THEN 'soundcloud_user'
          WHEN 'bandcamp'   THEN 'bandcamp_page'
          -- Defensive: any other platform that ever stored raw_data is
          -- preserved under a generic namespace rather than silently lost.
          ELSE 'enrichment_raw_' || ae.platform
        END                                AS namespace,
        ae.artist_id::text                 AS cache_key,
        ae.raw_data                        AS payload,
        COALESCE(ae.last_synced_at, now()) AS fetched_at
      FROM public.artist_enrichment ae
      WHERE ae.raw_data IS NOT NULL
      ON CONFLICT (namespace, cache_key)
      DO UPDATE SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at
    $copy$;
  END IF;
END $$;

-- 2. Drop the column (no app/script reads it anymore; the diagnostic now reads
--    api_response_cache). IF EXISTS keeps re-runs safe.
ALTER TABLE public.artist_enrichment DROP COLUMN IF EXISTS raw_data;
