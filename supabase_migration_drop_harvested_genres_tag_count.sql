-- Migration: drop the leftover Last.fm `tag_count` column from
-- artist_harvested_genres. Run once in the Supabase SQL editor.
--
-- The column only ever held the Last.fm per-tag "count" field — despite the
-- name, not a count but a 0–100 popularity score. harvest-genres-lastfm.mjs
-- was its only writer, and both that script and every row it wrote were
-- removed by supabase_migration_remove_lastfm_data.sql, leaving the column
-- NULL in 100% of rows.
--
-- No remaining source provides a per-genre weight: Spotify, MusicBrainz,
-- Bandcamp and HÖR all yield unweighted tag lists. If genre weighting is
-- added later it belongs on artist_genres (the live link table), not on this
-- staging table — and under a name that says "score", not "count".
--
-- Nothing depends on the column: no index, constraint, view or function
-- references it, and integrate-harvested-genres.mjs selected it without ever
-- reading it (that select is fixed in the same change as this migration).
--
-- Safe to re-run (IF EXISTS).

ALTER TABLE "public"."artist_harvested_genres"
  DROP COLUMN IF EXISTS "tag_count";
