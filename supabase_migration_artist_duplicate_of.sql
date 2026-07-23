-- Migration: artists.duplicate_of
-- Run once in the Supabase SQL editor BEFORE deploying the app change that
-- writes this column (the edit form's "Duplicate of" field).
--
-- Why:
--
--   directory_status = 'duplicate' records that an artist row duplicates
--   another entry, but not *which* one — so the canonical entry had to be
--   re-found by hand every time, and nothing could follow a duplicate to
--   the row that supersedes it.
--
--   duplicate_of holds that target: the id of the Rebalance Gender artist
--   this row duplicates. Nullable, because 'duplicate' can legitimately be
--   set before the canonical entry has been identified (and because the
--   harvest scripts that set the status don't populate a target).
--
-- Constraints:
--
--   - Foreign key to artists(id) so only real ids can be stored. ON DELETE
--     SET NULL rather than CASCADE: hard-deleting a canonical artist must
--     not delete the duplicates pointing at it, it should just leave them
--     untargeted. (Routine deletion here is the soft `deleted` flag, which
--     doesn't fire this at all — the app-level check rejects soft-deleted
--     targets on save.)
--   - CHECK that a row can't point at itself.
--
--   Deliberately NOT constrained at the DB level: "duplicate_of is only set
--   when directory_status = 'duplicate'". The app clears the column whenever
--   the status moves off 'duplicate', but a CHECK would make bulk status
--   flips in the harvest scripts fail mid-run instead.
--
--   Chained duplicates (A -> B where B is itself a duplicate) are rejected by
--   the app on save, not by SQL — expressing that in a CHECK would need a
--   trigger, and the existing rows this has to tolerate are unknown.
--
-- Safe to re-run (all three statements are guarded).

ALTER TABLE "public"."artists"
    ADD COLUMN IF NOT EXISTS "duplicate_of" "uuid";

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'artists_duplicate_of_fkey'
    ) THEN
        ALTER TABLE "public"."artists"
            ADD CONSTRAINT "artists_duplicate_of_fkey"
            FOREIGN KEY ("duplicate_of") REFERENCES "public"."artists"("id")
            ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'artists_duplicate_of_not_self'
    ) THEN
        ALTER TABLE "public"."artists"
            ADD CONSTRAINT "artists_duplicate_of_not_self"
            CHECK ("duplicate_of" IS DISTINCT FROM "id");
    END IF;
END $$;

-- Supports "which rows point at this artist?" (and keeps the FK's own
-- referential checks from scanning the table).
CREATE INDEX IF NOT EXISTS "idx_artists_duplicate_of"
    ON "public"."artists" ("duplicate_of")
    WHERE "duplicate_of" IS NOT NULL;
