-- Migration: remove Last.fm-derived data.
-- Run once in the Supabase SQL editor.
--
-- Why:
--
--   Last.fm's data was judged not useful enough to keep feeding the
--   directory. Its *links* are retained (artist_links rows with
--   platform = 'lastfm' are untouched, and the 'lastfm' row in
--   `platforms` stays so those links keep their foreign key), but
--   everything Last.fm contributed as *data* comes out:
--
--     - harvested genre tags, and the genres they promoted
--     - profile images
--     - the similar-artist graph
--
--   The code side of this change (harvest-genres-lastfm.mjs,
--   fetch-lastfm-similar.mjs, the Last.fm image-scrape candidate, the
--   Phase 3 link resolver's Last.fm service, LASTFM_API_KEY) is removed
--   in the same commit, so nothing re-creates these rows afterwards.
--
-- Order matters: step 2 reads artist_harvested_genres to work out which
-- genres came from Last.fm, so it must run before step 3 deletes those
-- rows. Run the whole file as one transaction.
--
-- NOT handled here — run these separately, see the footer:
--   - artist_images (Storage objects must go first; that's a script)
--   - recomputing artist_similarity_scores
--   - pruning genres left with no artists

begin;

-- ------------------------------------------------------------
-- 1. Back up the artist_genres rows step 2 is about to delete.
--
-- artist_genres carries no provenance column, so "came from Last.fm"
-- is inferred from the staging table: a pair is attributed to Last.fm
-- when a Last.fm harvested row was promoted to it and no other
-- source's harvested row maps to the same pair. That inference cannot
-- distinguish a genre an admin curated by hand from one Last.fm
-- happened to supply, so keep a copy — this is ~2,600 rows and the
-- delete is otherwise unrecoverable.
--
-- Drop this table once you're satisfied with the result.
-- ------------------------------------------------------------
create table artist_genres_lastfm_backup_20260730 as
select ag.artist_id, ag.genre_id
from artist_genres ag
where exists (
        select 1
        from artist_harvested_genres h
        where h.artist_id = ag.artist_id
          and h.genre_id  = ag.genre_id
          and h.source_platform = 'lastfm'
      )
  and not exists (
        select 1
        from artist_harvested_genres h2
        where h2.artist_id = ag.artist_id
          and h2.genre_id  = ag.genre_id
          and h2.source_platform <> 'lastfm'
      );

-- ------------------------------------------------------------
-- 2. Delete those artist_genres pairs.
--
-- Pairs that ANOTHER source also harvested (musicbrainz, bandcamp,
-- hoer) are left alone — Last.fm merely agreed with them, and the
-- other source still vouches for the genre.
-- ------------------------------------------------------------
delete from artist_genres ag
using artist_genres_lastfm_backup_20260730 b
where ag.artist_id = b.artist_id
  and ag.genre_id  = b.genre_id;

-- ------------------------------------------------------------
-- 3. Delete the Last.fm harvested tags themselves — the whole
--    staging history, whether promoted, skipped, or still pending.
-- ------------------------------------------------------------
delete from artist_harvested_genres
where source_platform = 'lastfm';

-- ------------------------------------------------------------
-- 4. Drop the similar-artist graph.
--
-- No runtime reader: artist_similarity_scores is built from genre /
-- MusicBrainz-tag / MusicBrainz-collab / SoundCloud-follow signals and
-- has no Last.fm component, so scoring is unaffected.
--
-- It did have one non-runtime reader, and losing it is a real cost:
-- tune-weights.py used this table as the validation ground truth for
-- grid-searching those five signal weights ("which pairs does Last.fm
-- think are similar?"). That script is deleted in this commit — if
-- Last.fm's similarity judgements aren't trusted enough to keep, they
-- are not a sound thing to tune against either. The weights currently
-- hard-coded in compute-scores.mjs stand until a new validation set
-- exists (hand-labelled pairs, or SoundCloud follow overlap).
-- ------------------------------------------------------------
drop table if exists lastfm_similar_artists;

-- ------------------------------------------------------------
-- 5. Cached Last.fm API responses.
--
-- Written by resolve-and-load-links-mb-sp.mjs, whose Last.fm
-- service is removed in this commit. Expected to be empty already.
-- ------------------------------------------------------------
delete from api_response_cache
where namespace in ('lastfm_tags', 'lastfm_search');

-- ------------------------------------------------------------
-- 6. Image-harvest failure records for the Last.fm scrape.
--
-- The images themselves are removed by the script below; this clears
-- the "already tried, no image" markers so nothing is left describing
-- a platform we no longer harvest. Covers the current service key
-- (image:lastfm) and the pre-unification ones.
-- ------------------------------------------------------------
delete from harvest_failures
where service like '%:lastfm';

-- ------------------------------------------------------------
-- 7. Stop offering Last.fm in the "missing links" admin workflow.
--
-- The `platforms` row itself must stay — artist_links.platform has a
-- foreign key to it and the existing Last.fm links are retained. But
-- /admin/missing-links lists exactly those platforms that have a
-- search_url_template, so clearing it is what takes Last.fm out of the
-- link-finding UI without disturbing the stored links. That column has
-- no other consumer (see src/lib/platforms.ts, buildPlatformSearchUrl).
-- ------------------------------------------------------------
update platforms
set search_url_template = null
where key = 'lastfm';

commit;

-- ============================================================
-- After this migration
-- ============================================================
--
-- 1. Images (346 rows, 343 with a re-hosted Storage object). Storage
--    objects must be removed before the rows, so this is the existing
--    script rather than SQL. It also clears the harvest_failures rows
--    step 6 covers, so running it after this file is harmless:
--
--      DRY_RUN=1 npx tsx scripts/prune-artist-images.mjs --platform=lastfm
--      npx tsx scripts/prune-artist-images.mjs --platform=lastfm
--
--    Two artists have a Last.fm image as their only displayable photo
--    and will fall back to no image; every other affected artist has at
--    least one image from another platform.
--
-- 2. Recompute similarity, whose genre_score component just changed
--    for the ~500 artists that lost genres:
--
--      node scripts/compute-scores.mjs
--
-- 3. Genres left with no artists at all. Review and cut them with the
--    normal vocabulary tools rather than deleting blind:
--
--      node scripts/genre-report.mjs
--      node scripts/prune-genres.mjs --dry-run
--
--    To see the newly-empty ones first:
--
--      select g.id, g.name, g.status
--      from genres g
--      where not exists (select 1 from artist_genres ag where ag.genre_id = g.id)
--      order by g.name;
--
-- 4. Once the result looks right:
--
--      drop table artist_genres_lastfm_backup_20260730;
