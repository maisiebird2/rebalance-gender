-- Migration: backfill SoundCloud & Bandcamp bios into biographies
-- Run once in the Supabase SQL editor, AFTER supabase_migration_biographies.sql
-- (which creates the biographies table).
--
-- Why:
--
--   biographies is the one-bio-per-artist-per-platform home for bios (see
--   supabase_migration_biographies.sql). sync-discogs already writes it
--   directly (platform = 'discogs'), but SoundCloud and Bandcamp bios so far
--   only live in artist_harvested_bios (the raw audit trail). This copies the
--   existing SoundCloud/Bandcamp rows from artist_harvested_bios into
--   biographies so the new table is populated for those two platforms too.
--
--   Going forward, sync-soundcloud.mjs and sync-bandcamp.mjs write biographies
--   directly (in addition to still keeping the raw audit trail in
--   artist_harvested_bios, same pattern as sync-discogs), so this backfill only
--   ever needs to run once.
--
--   artist_harvested_bios holds RAW text; biographies holds display-ready text.
--   For Bandcamp the two are identical (the scrape writes the same string to
--   both), so the backfill is exact. For SoundCloud the raw text is copied as a
--   seed; the next sync-soundcloud run replaces it with the parsed/cleaned bio
--   (booking/management/contact/linktree stripped, no platform prefix). We do
--   not attempt to reproduce that JS-side cleaning in SQL.
--
--   ON CONFLICT DO NOTHING: never clobber a biographies row that already exists
--   for the same (artist_id, platform) — a direct sync write is fresher than
--   this one-time backfill.
--
--   source_platform in artist_harvested_bios maps to platform in biographies.
--
-- Safe to re-run (idempotent via ON CONFLICT DO NOTHING).

INSERT INTO "public"."biographies" ("artist_id", "platform", "bio", "source_url")
SELECT "artist_id", "source_platform", "raw_bio", "source_url"
FROM "public"."artist_harvested_bios"
WHERE "source_platform" IN ('soundcloud', 'bandcamp')
  AND "raw_bio" IS NOT NULL
  AND "btrim"("raw_bio") <> ''
ON CONFLICT ("artist_id", "platform") DO NOTHING;
