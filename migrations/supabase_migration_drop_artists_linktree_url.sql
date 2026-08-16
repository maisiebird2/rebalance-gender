-- Migration: drop the retired `linktree_url` column from artists.
-- Run once in the Supabase SQL editor.
--
-- The column predates artist_links. A Linktree link is a platform link
-- like any other and has lived in artist_links (platform = 'linktree')
-- for a long time; nothing has written to this column since. The app
-- never read it either — src/ contains no reference to it.
--
-- The 183 values left in it were drained by
-- scripts/migrate-linktree-to-links.ts on 2026-08-16, which staged each
-- one into artist_harvested_links (source_platform = 'linktree') for
-- Phase 2d to promote, then cleared the column. That script was the
-- prerequisite for this migration, and the guard below refuses to run
-- until the column is empty: a link that only exists in this column
-- would otherwise be destroyed outright.
--
-- That script has since been deleted — with the column gone it could
-- only ever fail — so on a database where the guard DOES fire (a
-- restore, or another environment that never had the drain run),
-- recover it from git history: it was removed in the commit that added
-- this line, and PIPELINE.md's "Legacy scripts" section describes what
-- it did.
--
-- Nothing else depends on the column: no index, constraint, view or
-- function references it, and no script selects it apart from the
-- migration named above.
--
-- ONE follow-up, in the same change as this file:
-- supabase_migration_artists_private_columns.sql lists "linktree_url"
-- in its GRANT SELECT column list. That file has been updated to drop
-- it; an un-updated copy would fail on its next run with "column
-- linktree_url does not exist". Nothing needs re-running now — dropping
-- a column drops its grants with it, and the remaining grants are
-- untouched.
--
-- Safe to re-run: the guard notices an already-dropped column and the
-- DROP is IF EXISTS.

BEGIN;

-- Guard: refuse to drop a column that still holds data.
DO $$
DECLARE
  remaining bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'artists'
       AND column_name = 'linktree_url'
  ) THEN
    RAISE NOTICE 'artists.linktree_url is already dropped — nothing to do.';
    RETURN;
  END IF;

  -- EXECUTE, not a plain SELECT: on a re-run the column is gone, and a
  -- direct reference would fail to plan even though the RETURN above
  -- means it is never reached.
  EXECUTE 'SELECT count(*) FROM public.artists WHERE linktree_url IS NOT NULL'
     INTO remaining;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'artists.linktree_url still holds % non-null value(s). Stage them '
      'into artist_harvested_links first (see the header — recover '
      'scripts/migrate-linktree-to-links.ts from git history); dropping '
      'now would destroy them.',
      remaining;
  END IF;
END
$$;

ALTER TABLE "public"."artists"
  DROP COLUMN IF EXISTS "linktree_url";

COMMIT;
