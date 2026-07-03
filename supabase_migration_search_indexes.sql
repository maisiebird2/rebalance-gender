-- Speed up directory name search.
--
-- The directory search runs:
--   ... WHERE directory_status = 'approved' AND deleted = false
--       AND name_search ILIKE '%term%'
--
-- A leading-wildcard ILIKE can't use the existing btree index
-- (idx_artists_name_search), so every search seq-scans the whole artists
-- table — including the large mass of not_eligible / sc_followee graph
-- nodes. A GIN trigram index supports %term% lookups, and making it
-- partial restricts it to the actual directory subset, so graph-node
-- growth no longer affects search speed.
--
-- Run in the Supabase SQL editor (or psql). Safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram index over the normalized search column, limited to rows the
-- directory query can actually return. The planner will only use it when
-- the query includes both filter conditions — which getArtists() does.
CREATE INDEX IF NOT EXISTS idx_artists_name_search_trgm_approved
  ON artists
  USING gin (name_search gin_trgm_ops)
  WHERE directory_status = 'approved' AND deleted = false;

-- The old btree index on name_search can't serve %term% patterns and is
-- dead weight on every insert of a graph node. Drop it.
DROP INDEX IF EXISTS idx_artists_name_search;

-- Optional sanity check after creating the index (should show a Bitmap
-- Index Scan on idx_artists_name_search_trgm_approved, not a Seq Scan):
--
-- EXPLAIN ANALYZE
-- SELECT id, name FROM artists
-- WHERE directory_status = 'approved' AND deleted = false
--   AND name_search ILIKE '%smith%';
