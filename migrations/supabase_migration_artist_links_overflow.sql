-- Migration: allow overflow `other` links on artist_links
-- Run once in the Supabase SQL editor.
--
-- Why:
--
--   documentation/PROPOSAL-platform-links-v2.md replaces the per-platform
--   link fields with one "paste a URL" list. The platform is derived from
--   the URL, the FIRST link on a known host takes that platform, and every
--   later link on the same host — plus anything on an unrecognised host —
--   is filed under 'other' instead of being discarded.
--
--   `artist_links_artist_platform_unique` — UNIQUE (artist_id, platform) —
--   forbids exactly that: it permits one 'other' row per artist, when the
--   whole point of the overflow bucket is that it is unlimited. So this is
--   a REPLACEMENT, not an addition. The new partial unique index keeps the
--   real invariant ("at most one PRIMARY link per known platform") and stops
--   applying to the overflow bucket:
--
--       UNIQUE (artist_id, platform) WHERE platform <> 'other'
--
--   not_found markers (url NULL, not_found true) are known-platform rows, so
--   the partial index still allows exactly one per platform — a platform is
--   either linked or marked not-found, never both, which is the shape
--   scripts/integrate-harvested-links.mjs already assumes.
--
--   `artist_links_artist_id_platform_url_key` — UNIQUE (artist_id, platform,
--   url) — is DELIBERATELY LEFT IN PLACE. It is what stops the overflow
--   bucket accumulating byte-identical copies of the same URL, which is the
--   dedupe rule §6 of the proposal relies on ("overflow is for *different*
--   links, not copies"). It does not constrain distinct 'other' URLs.
--
--   Nothing user-visible changes when this lands on its own: every writer
--   today maintains one-row-per-platform by itself. It is a prerequisite for
--   the assignPlatforms() work, not a behaviour change in itself.
--
--   ONE WRITER BREAKS, and must ship with this: the revision-apply merge in
--   src/app/admin/actions.ts upserts with onConflict "artist_id,platform".
--   PostgREST cannot target a partial index, so that upsert is rewritten as
--   read-modify-write through assignPlatforms(). See the proposal §2/§5.
--
--   organisation_links is deliberately UNTOUCHED — organisations are out of
--   scope for this release (proposal open question 8), so
--   `organisation_links_organisation_platform_unique` stays a full unique
--   constraint and that form keeps a strict one-link-per-platform list.

BEGIN;

-- 1. Drop the full unique constraint (and with it its backing index).
ALTER TABLE public.artist_links
  DROP CONSTRAINT IF EXISTS artist_links_artist_platform_unique;

-- 2. Re-assert the invariant for everything except the overflow bucket.
--    A partial index, so it cannot be a table CONSTRAINT — which is also why
--    the supabase-js upsert that leaned on the old constraint has to change.
CREATE UNIQUE INDEX IF NOT EXISTS artist_links_artist_platform_primary_unique
  ON public.artist_links (artist_id, platform)
  WHERE platform <> 'other';

COMMIT;

-- Verify:
--
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.artist_links'::regclass ORDER BY conname;
--   -- expect artist_links_artist_id_platform_url_key to REMAIN and
--   -- artist_links_artist_platform_unique to be GONE.
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'artist_links';
--   -- expect artist_links_artist_platform_primary_unique to be present.
--
-- Rollback (only possible while no artist has two 'other' rows):
--
--   DROP INDEX IF EXISTS public.artist_links_artist_platform_primary_unique;
--   ALTER TABLE public.artist_links
--     ADD CONSTRAINT artist_links_artist_platform_unique UNIQUE (artist_id, platform);
