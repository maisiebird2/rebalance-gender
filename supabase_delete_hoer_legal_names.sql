-- Delete all artist_legal_names rows for platform = 'hoer'.
--
-- Why: sync-hoer.mjs seeded this table from the ppma_author term `name`,
-- believing it to be the artist's LEGAL name. It is not — it is usually the
-- stage name, and sometimes just the slug:
--
--     term 14628 -> 'GMOZ'     (stage name; legal name is Georgia Morrow)
--     term 14883 -> 'Romsy1'   (the slug, WP uniqueness digit included)
--     term 12361 -> 'Posi Flo' (stage name)
--
-- The rework (scripts/HOER-SYNC-REWORK-PLAN.md) repopulates this table from
-- the posts feed's authors[].first_name + last_name instead, which is a
-- genuinely structured legal name. This clears the bad data first.
--
-- NOTE: artist_legal_names is SHARED with sync-discogs. Every statement below
-- is scoped to platform = 'hoer'. Do not remove that predicate.
--
-- Run the steps in order, in the Supabase SQL editor.

-- ------------------------------------------------------------
-- Step 1 — look before deleting.
--
-- How many rows, and do they look like the machine-written junk described
-- above? `matches_artist_name` = true means the stored "legal name" is just
-- the artist's display name, i.e. certainly wrong. Rows where it is false are
-- the ones worth a glance before you proceed — a few may be real legal names,
-- or hand-corrections someone made in the admin UI.
-- ------------------------------------------------------------

SELECT count(*) AS hoer_rows
FROM public.artist_legal_names
WHERE platform = 'hoer';

SELECT
    ln.legal_name,
    a.name AS artist_name,
    lower(ln.legal_name) = lower(a.name) AS matches_artist_name,
    a.directory_status,
    ln.source_url,
    ln.created_at,
    ln.updated_at,
    ln.updated_at > ln.created_at AS edited_since_insert
FROM public.artist_legal_names ln
JOIN public.artists a ON a.id = ln.artist_id
WHERE ln.platform = 'hoer'
ORDER BY matches_artist_name, edited_since_insert DESC, a.name;

-- ------------------------------------------------------------
-- Step 2 — back the rows up.
--
-- Cheap insurance, and it survives the delete. Drop the table once you are
-- satisfied the rework repopulated things correctly.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.artist_legal_names_hoer_backup_20260722 AS
SELECT * FROM public.artist_legal_names WHERE platform = 'hoer';

SELECT count(*) AS backed_up
FROM public.artist_legal_names_hoer_backup_20260722;

-- ------------------------------------------------------------
-- Step 3 — delete.
--
-- Wrapped in a transaction so you can read the reported row count and decide.
-- Run the DELETE, confirm the count matches Step 1, then run COMMIT.
-- Run ROLLBACK instead if anything looks off.
-- ------------------------------------------------------------

BEGIN;

DELETE FROM public.artist_legal_names
WHERE platform = 'hoer';

-- Confirm the count, then:
COMMIT;
-- ROLLBACK;

-- ------------------------------------------------------------
-- Step 4 — verify.
-- ------------------------------------------------------------

SELECT platform, count(*) AS remaining
FROM public.artist_legal_names
GROUP BY platform
ORDER BY platform;
