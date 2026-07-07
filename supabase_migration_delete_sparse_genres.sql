-- Migration: mark under-threshold genres as 'deleted'
-- Run against your live Supabase database (SQL Editor).
--
-- Purpose: we are moving the submit/edit genre pickers off the live "≥3
-- approved artists" count gate and onto genres.status = 'approved'. Before
-- that switch, this one-off migration bakes the old threshold into status:
-- every currently-'approved' genre with fewer than 3 approved artists is
-- set to 'deleted', so it stops appearing in the pickers.
--
-- After running this you can hand-pick individual genres back to 'approved'
-- (they will show in the pickers immediately, regardless of artist count).
--
-- "approved artist" here == artists.directory_status = 'approved' AND
-- artists.deleted = false, matching MIN_APPROVED_ARTISTS_FOR_GENRE /
-- getGenreOptions() in src/lib/queries.ts. Genres already 'deleted' or
-- 'pending' are left untouched. 'deleted' is reversible (the genres row and
-- its artist_genres links are kept), so this migration is safe to re-run.

-- ────────────────────────────────────────────────────────────
-- 0. Threshold (keep in sync with MIN_APPROVED_ARTISTS_FOR_GENRE = 3)
-- ────────────────────────────────────────────────────────────
-- A genre needs at least THIS many approved artists to stay 'approved'.
-- Below it → 'deleted'. Change the two literal 3's below together if you
-- ever move the threshold.

-- ────────────────────────────────────────────────────────────
-- 1. PREVIEW (read-only) — run this first to see what will change
-- ────────────────────────────────────────────────────────────
-- Lists every currently-'approved' genre that would be flipped to
-- 'deleted', with its approved-artist count. Nothing is written.
select
  g.id,
  g.name,
  count(a.id) as approved_artist_count
from public.genres g
left join public.artist_genres ag on ag.genre_id = g.id
left join public.artists a
  on a.id = ag.artist_id
  and a.directory_status = 'approved'
  and a.deleted = false
where g.status = 'approved'
group by g.id, g.name
having count(a.id) < 3
order by approved_artist_count desc, g.name;

-- ────────────────────────────────────────────────────────────
-- 2. APPLY — flip under-threshold approved genres to 'deleted'
-- ────────────────────────────────────────────────────────────
-- Wrapped in a transaction. Review the row count it reports; if it looks
-- wrong, ROLLBACK instead of COMMIT.
begin;

update public.genres g
set status = 'deleted'
where g.status = 'approved'
  and (
    select count(*)
    from public.artist_genres ag
    join public.artists a on a.id = ag.artist_id
    where ag.genre_id = g.id
      and a.directory_status = 'approved'
      and a.deleted = false
  ) < 3;

commit;

-- ────────────────────────────────────────────────────────────
-- 3. VERIFY (read-only) — should return 0 rows after the update
-- ────────────────────────────────────────────────────────────
select
  g.id,
  g.name,
  count(a.id) as approved_artist_count
from public.genres g
left join public.artist_genres ag on ag.genre_id = g.id
left join public.artists a
  on a.id = ag.artist_id
  and a.directory_status = 'approved'
  and a.deleted = false
where g.status = 'approved'
group by g.id, g.name
having count(a.id) < 3
order by g.name;
