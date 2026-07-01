-- Migration: follow-graph tracking in artist_enrichment
-- Run this once in the Supabase SQL editor before running
-- build-soundcloud-follow-graph.mjs with the updated script.
--
-- What this adds:
--
--   1. follow_graph_built_at (timestamptz) on artist_enrichment
--      Set by the script when it successfully processes a source artist's
--      followings. NULL means "not yet processed" (or "needs re-processing").
--      Used instead of the local cache file to decide which artists to skip
--      on subsequent runs.
--
--   2. A trigger on artist_links that clears follow_graph_built_at and
--      sync_error on the corresponding artist_enrichment row whenever the
--      SoundCloud URL is changed. This means fixing a dead link in the
--      database is enough to queue the artist for re-processing on the next
--      script run — no manual cache editing required.

-- 1. Add the new column (safe to run multiple times).
ALTER TABLE artist_enrichment
  ADD COLUMN IF NOT EXISTS follow_graph_built_at timestamptz;

-- 2. Trigger function: fires after any UPDATE that changes the url column
--    on artist_links. Clears the follow-graph tracking state for the
--    affected artist + platform so the next script run picks them up.
CREATE OR REPLACE FUNCTION clear_enrichment_on_url_change()
RETURNS TRIGGER AS $$
BEGIN
  -- IS DISTINCT FROM handles NULLs correctly (unlike !=).
  IF NEW.url IS DISTINCT FROM OLD.url THEN
    UPDATE artist_enrichment
       SET sync_error            = NULL,
           follow_graph_built_at = NULL
     WHERE artist_id = NEW.artist_id
       AND platform  = NEW.platform;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Attach the trigger (drop first so re-running this file is safe).
DROP TRIGGER IF EXISTS trg_artist_links_url_change ON artist_links;

CREATE TRIGGER trg_artist_links_url_change
  AFTER UPDATE OF url ON artist_links
  FOR EACH ROW
  EXECUTE FUNCTION clear_enrichment_on_url_change();

-- 4. Backfill: any source artist already present in sc_follow_edges has had
--    their followings fetched. Mark them as done so the script skips them.
UPDATE artist_enrichment ae
   SET follow_graph_built_at = now()
 WHERE ae.platform            = 'soundcloud'
   AND ae.follow_graph_built_at IS NULL
   AND EXISTS (
     SELECT 1 FROM sc_follow_edges e
      WHERE e.follower_artist_id = ae.artist_id
   );
