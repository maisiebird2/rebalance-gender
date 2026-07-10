-- Backfill: artist_images from legacy image sources
-- Run once in the Supabase SQL editor, AFTER
-- supabase_migration_artist_images.sql, and BEFORE relying on
-- artist_images as the source of truth (the rewritten
-- store-images.mjs, and the frontend read path) — otherwise both
-- start from an empty table and every existing image gets refetched
-- from scratch instead of reused.
--
-- Also run this before considering any of the columns it reads from
-- for removal (artists.profile_image_url / profile_image_source /
-- profile_image_fetched_at / sc_image_url) — see scripts/PIPELINE.md,
-- "Multi-image artist_images table", for the full removal checklist.
-- This script only reads those columns; it doesn't touch or clear them.
--
-- Three sources, three INSERTs, each restricted to approved
-- (directory_status = 'approved', deleted = false) artists — images
-- are only ever kept for directory artists, and these are the only
-- rows any writer would have produced anyway. Every INSERT uses
-- ON CONFLICT (artist_id, platform) DO NOTHING, so this is safe to
-- re-run and never overwrites a row a live script (enrich-images.ts,
-- sync-soundcloud.mjs, sync-bandcamp.mjs) already wrote.
--
-- Order matters only in the sense that earlier INSERTs claim the
-- (artist_id, platform) pair first via ON CONFLICT DO NOTHING — later
-- ones are pure fallbacks for pairs nothing else already covered:
--
--   1. sc_image_url — the legacy SoundCloud-specific column. When
--      profile_image_source was 'soundcloud', the old
--      supabase_migration_sc_image_url.sql migration moved the image
--      URL here and nulled out profile_image_url, so this is the only
--      place many artists' SoundCloud image still lives.
--   2. artist_enrichment.profile_image_url — one row per (artist,
--      platform) already, written by sync-soundcloud.mjs and
--      sync-bandcamp.mjs (pre-artist_images versions) and, historically,
--      by other harvesters. Covers every platform, including
--      soundcloud for artists that have an enrichment row but never
--      got an sc_image_url (step 1 didn't claim them).
--   3. artists.profile_image_url / profile_image_source — the old
--      single "current best guess" enrich-images.ts (5a) used to
--      write directly, for whatever platform it came from. Only
--      fills in a row when nothing above already covers that
--      (artist, platform) pair — e.g. an image 5a found but which
--      never got a matching artist_enrichment row. Note: if this
--      artist was already re-hosted by the OLD store-images.mjs,
--      profile_image_url here is a Storage URL (our own
--      artist-images/{id}.{ext} path), not the original external
--      URL — that's still a usable source_url (the new
--      store-images.mjs will just re-host it again, from Storage to
--      Storage, under the new per-platform path), just not the
--      *original* source. Harmless, not worth special-casing.
--
-- fetched_at falls back to now() where the legacy column had no
-- timestamp to carry over.

-- 1. SoundCloud, from the legacy sc_image_url column — guarded.
-- artists.sc_image_url is added by supabase_migration_sc_image_url.sql,
-- a separate, older migration; if that was never run against this
-- database, the column simply doesn't exist yet (this is what
-- produced "column a.sc_image_url does not exist" the first time
-- this script ran against a database missing it). Wrapped in a DO
-- block that checks information_schema first, so this step is
-- silently skipped rather than erroring out when the column is
-- absent — steps 2 and 3 below still cover SoundCloud images from
-- every other source regardless. Run supabase_migration_sc_image_url.sql
-- and re-run this script if you specifically want that legacy
-- column's data folded in too (safe to re-run either way — every
-- INSERT here uses ON CONFLICT DO NOTHING).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'artists' AND column_name = 'sc_image_url'
  ) THEN
    INSERT INTO "public"."artist_images" ("artist_id", "platform", "source_url", "fetched_at")
    SELECT "a"."id", 'soundcloud', "a"."sc_image_url", COALESCE("a"."profile_image_fetched_at", "now"())
    FROM "public"."artists" "a"
    WHERE "a"."directory_status" = 'approved'
      AND "a"."deleted" = false
      AND "a"."sc_image_url" IS NOT NULL
    ON CONFLICT ("artist_id", "platform") DO NOTHING;
  ELSE
    RAISE NOTICE 'artists.sc_image_url does not exist — skipping step 1. Run supabase_migration_sc_image_url.sql first if you want this legacy column''s data included (steps 2 and 3 below already cover SoundCloud images from artist_enrichment and artists.profile_image_url).';
  END IF;
END $$;

-- 2. Every platform's artist_enrichment.profile_image_url.
INSERT INTO "public"."artist_images" ("artist_id", "platform", "source_url", "fetched_at")
SELECT "ae"."artist_id", "ae"."platform", "ae"."profile_image_url", COALESCE("ae"."last_synced_at", "now"())
FROM "public"."artist_enrichment" "ae"
JOIN "public"."artists" "a" ON "a"."id" = "ae"."artist_id"
WHERE "a"."directory_status" = 'approved'
  AND "a"."deleted" = false
  AND "ae"."profile_image_url" IS NOT NULL
ON CONFLICT ("artist_id", "platform") DO NOTHING;

-- 3. artists.profile_image_url / profile_image_source — 5a's old
--    single pick, only where nothing above already covers that platform.
INSERT INTO "public"."artist_images" ("artist_id", "platform", "source_url", "fetched_at")
SELECT "a"."id", "a"."profile_image_source", "a"."profile_image_url", COALESCE("a"."profile_image_fetched_at", "now"())
FROM "public"."artists" "a"
WHERE "a"."directory_status" = 'approved'
  AND "a"."deleted" = false
  AND "a"."profile_image_url" IS NOT NULL
  AND "a"."profile_image_source" IS NOT NULL
ON CONFLICT ("artist_id", "platform") DO NOTHING;
