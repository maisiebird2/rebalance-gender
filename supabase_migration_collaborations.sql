-- Migration: mb_collaborations -> collaborations (platform-neutral)
-- Run once in the Supabase SQL editor.
--
-- Why:
--
--   mb_collaborations held one edge per unordered artist pair
--   (artist_id_a < artist_id_b), written only by enrich-musicbrainz.mjs.
--   Now that sync-discogs.mjs also derives collaboration/membership
--   edges (from a Discogs artist's `members`/`groups`), the table is no
--   longer MusicBrainz-specific. It is renamed `collaborations` and
--   gains a `source_platform` column so each platform's edge for the
--   same pair is its own row.
--
--   Existing rows are all from MusicBrainz, so source_platform
--   backfills to 'musicbrainz' (the column default during the add,
--   which is then dropped so future writers must state their source).
--
--   Uniqueness moves from (artist_id_a, artist_id_b) to
--   (artist_id_a, artist_id_b, source_platform): MusicBrainz and
--   Discogs can each record the same pair once, and each writer
--   upsert-increments only its own row. The a<b CHECK, the FKs, the
--   updated_at trigger, the per-column indexes, RLS, and grants all
--   carry over unchanged (a table rename keeps its dependent objects;
--   their names still say "mb_collab*" but that is cosmetic).
--
--   Readers (compute-scores.mjs, scripts/lib/scoring.py) already
--   collapse rows into a set of canonical pairs, so they read the
--   renamed table with no filter and now transparently union the
--   MusicBrainz and Discogs edges into the same collaboration signal.
--
-- Safe to re-run (guards make each step idempotent).

-- 1. Rename the table (only if the old name still exists).
ALTER TABLE IF EXISTS "public"."mb_collaborations" RENAME TO "collaborations";

-- 2. Add source_platform, backfilling existing rows to 'musicbrainz'
--    via the column default, then drop the default so new writers must
--    specify it explicitly.
ALTER TABLE "public"."collaborations"
    ADD COLUMN IF NOT EXISTS "source_platform" "text" NOT NULL DEFAULT 'musicbrainz';
ALTER TABLE "public"."collaborations"
    ALTER COLUMN "source_platform" DROP DEFAULT;

-- 3. Swap the uniqueness key: drop the old 2-column unique, add the
--    3-column one. (Old constraint keeps its original name after the
--    rename; drop it by that name.)
ALTER TABLE "public"."collaborations"
    DROP CONSTRAINT IF EXISTS "mb_collaborations_artist_id_a_artist_id_b_key";
ALTER TABLE "public"."collaborations"
    DROP CONSTRAINT IF EXISTS "collaborations_artist_id_a_artist_id_b_source_platform_key";
ALTER TABLE "public"."collaborations"
    ADD CONSTRAINT "collaborations_artist_id_a_artist_id_b_source_platform_key"
    UNIQUE ("artist_id_a", "artist_id_b", "source_platform");

-- 4. Index source_platform so a per-platform purge/report doesn't seq-scan.
CREATE INDEX IF NOT EXISTS "idx_collaborations_source_platform"
    ON "public"."collaborations" ("source_platform");
