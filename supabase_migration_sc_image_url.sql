-- Migration: add sc_image_url to artists
-- Run once in the Supabase SQL editor.
--
-- What this does:
--   1. Adds sc_image_url (text, nullable) to artists.
--   2. Copies the current profile_image_url into sc_image_url for every artist
--      whose image came from SoundCloud (profile_image_source = 'soundcloud').
--   3. Nulls out profile_image_url for those rows so the column is free to
--      hold the Supabase Storage URL once store-images.mjs has run.
--
-- Artists whose profile_image_source is not 'soundcloud' (or is null) are
-- left untouched — their profile_image_url is preserved as-is.

-- 1. Add the column (safe to run multiple times).
ALTER TABLE artists
  ADD COLUMN IF NOT EXISTS sc_image_url text;

-- 2. Copy + clear in one statement.
UPDATE artists
   SET sc_image_url      = profile_image_url,
       profile_image_url = NULL
 WHERE profile_image_source = 'soundcloud'
   AND profile_image_url IS NOT NULL;
