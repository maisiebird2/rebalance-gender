-- Migration: strip a leading "www." from Bandcamp URLs
-- Run once in the Supabase SQL editor.
--
-- Why:
--
--   Bandcamp serves every artist/label from a bare subdomain
--   (foo.bandcamp.com) and 301-redirects the www. variant to it. The
--   www. host is never the canonical page: loading
--   https://www.foo.bandcamp.com/ makes Firefox flag a potential
--   security risk, and forcing through resolves to
--   https://foo.bandcamp.com/ anyway. Some rows were stored with the
--   www. prefix, so this rewrites them to the canonical bare-subdomain
--   host.
--
--   Going forward the app no longer produces www. Bandcamp URLs: the
--   form save paths route through lib/profile-links.ts, whose bandcamp
--   handle extraction now strips a leading www., and sync-bandcamp.mjs
--   normalizes the same way before fetching/recording a URL. This
--   migration cleans the existing data.
--
-- What it touches:
--
--   • artist_links.url            where platform = 'bandcamp'   (live)
--   • artist_harvested_links.parsed_url
--                                 where parsed_platform = 'bandcamp' (staging;
--                                 promoted to artist_links by integrate-harvested-links)
--
--   Only the functional/display URLs are rewritten. The audit columns
--   that deliberately preserve the as-found value —
--   artist_links.original_url and artist_harvested_links.raw_url — are
--   left untouched on purpose (they are never loaded in a browser).
--
-- Matching:
--
--   A row is rewritten only when its URL looks like
--   http(s)://www.<sub>.bandcamp.com... i.e. www. immediately follows
--   the scheme AND there is a real subdomain before .bandcamp.com. The
--   regexp_replace drops just that "www." and leaves the scheme, the
--   rest of the host, the path, and the trailing-slash shape exactly as
--   they were. The bare apex www.bandcamp.com (no artist subdomain) is
--   intentionally NOT matched.
--
-- Trigger note:
--
--   artist_links has trg_artist_links_url_change, which on any url
--   change nulls sync_error and follow_graph_built_at for that
--   (artist_id, platform) in artist_enrichment. Rewritten Bandcamp rows
--   will therefore have their bandcamp enrichment state reset and get
--   re-synced on the next sync-bandcamp run. The www. and bare host
--   serve identical content, so this is a harmless re-fetch, not data
--   loss.
--
-- Idempotent / safe to re-run: after one pass no row matches the
-- www.<sub>.bandcamp.com pattern, so a second run rewrites nothing.

-- 1. Live links -------------------------------------------------------
UPDATE public.artist_links
   SET url = regexp_replace(
               url,
               '^(https?://)www\.([a-z0-9-]+\.bandcamp\.com)',
               '\1\2',
               'i'
             )
 WHERE platform = 'bandcamp'
   AND url ~* '^https?://www\.[a-z0-9-]+\.bandcamp\.com';

-- 2. Staging (harvested) links ---------------------------------------
UPDATE public.artist_harvested_links
   SET parsed_url = regexp_replace(
                      parsed_url,
                      '^(https?://)www\.([a-z0-9-]+\.bandcamp\.com)',
                      '\1\2',
                      'i'
                    )
 WHERE parsed_platform = 'bandcamp'
   AND parsed_url ~* '^https?://www\.[a-z0-9-]+\.bandcamp\.com';
