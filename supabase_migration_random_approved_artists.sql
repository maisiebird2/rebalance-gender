-- Random-sample the directory in Postgres instead of in the app.
--
-- getRandomArtists() previously fetched EVERY approved artist's id
-- (SELECT id FROM artists WHERE directory_status='approved' ...), shipped
-- that whole list to Node, shuffled it in JS, and kept 24. The id payload
-- grows linearly with the directory forever, and it's pure waste — only a
-- single page is ever shown.
--
-- This function moves the sampling into the database: it returns just
-- `sample_size` random approved ids, so the app receives a small, constant
-- payload. The ORDER BY random() scans only the approved subset (backed by
-- the partial index on directory_status='approved' AND deleted=false), not
-- the graph-node bloat in the artists table.
--
-- SECURITY INVOKER (the default): the function runs with the caller's
-- rights, so Row Level Security still restricts reads to approved rows —
-- same guarantee as the direct SELECT it replaces. Marked VOLATILE so
-- random() is re-evaluated on every call (a STABLE wrapper could let the
-- planner reuse one draw within a statement).
--
-- Run in the Supabase SQL editor (or psql). Safe to re-run.

CREATE OR REPLACE FUNCTION public.random_approved_artist_ids(sample_size integer)
RETURNS TABLE (id uuid)
LANGUAGE sql
VOLATILE
AS $$
  SELECT a.id
  FROM public.artists a
  WHERE a.directory_status = 'approved'
    AND a.deleted = false
  ORDER BY random()
  LIMIT GREATEST(COALESCE(sample_size, 0), 0);
$$;

-- The public site calls this with the anon (publishable) key; the admin
-- tooling uses authenticated sessions. Grant EXECUTE to both. RLS on
-- artists still applies (SECURITY INVOKER), so this exposes nothing the
-- existing directory queries didn't already.
GRANT EXECUTE ON FUNCTION public.random_approved_artist_ids(integer)
  TO anon, authenticated;

-- Quick check (should return `sample_size` rows, different order each run):
--
-- SELECT * FROM random_approved_artist_ids(24);
