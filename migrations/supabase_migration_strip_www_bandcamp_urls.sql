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
-- Duplicate handling:
--
--   For some artists both variants are already stored — a www. row AND
--   the identical bare-subdomain row (e.g. http://www.x.bandcamp.com/
--   alongside http://x.bandcamp.com/). Both tables have a unique
--   constraint (artist_links: artist_id+platform+url;
--   artist_harvested_links: artist_id+parsed_url), so blindly rewriting
--   the www. row would collide with its twin. So each table is handled
--   in two steps: first DELETE any www. row whose stripped form already
--   exists as a non-www row for that artist (the canonical row is
--   already present, the www. row is redundant), then UPDATE the
--   remaining www. rows. Two distinct www. rows can never strip to the
--   same value (only "www." is removed; scheme/path/slash are kept), so
--   after the delete the update can't collide.
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
-- Runs as one transaction in the SQL editor (all-or-nothing).
-- Idempotent / safe to re-run: after one pass no row matches the
-- www.<sub>.bandcamp.com pattern, so a second run changes nothing.

-- 1a. Live links — drop www. rows that already have a non-www twin ----
DELETE FROM public.artist_links w
 USING public.artist_links n
 WHERE w.platform = 'bandcamp'
   AND w.url ~* '^https?://www\.[a-z0-9-]+\.bandcamp\.com'
   AND n.artist_id = w.artist_id
   AND n.platform  = w.platform
   AND n.id <> w.id
   AND n.url = regexp_replace(
                 w.url,
                 '^(https?://)www\.([a-z0-9-]+\.bandcamp\.com)',
                 '\1\2',
                 'i'
               );

-- 1b. Live links — rewrite the remaining www. rows -------------------
UPDATE public.artist_links
   SET url = regexp_replace(
               url,
               '^(https?://)www\.([a-z0-9-]+\.bandcamp\.com)',
               '\1\2',
               'i'
             )
 WHERE platform = 'bandcamp'
   AND url ~* '^https?://www\.[a-z0-9-]+\.bandcamp\.com';

-- 2a. Staging links — drop www. rows that already have a non-www twin -
DELETE FROM public.artist_harvested_links w
 USING public.artist_harvested_links n
 WHERE w.parsed_platform = 'bandcamp'
   AND w.parsed_url ~* '^https?://www\.[a-z0-9-]+\.bandcamp\.com'
   AND n.artist_id = w.artist_id
   AND n.id <> w.id
   AND n.parsed_url = regexp_replace(
                        w.parsed_url,
                        '^(https?://)www\.([a-z0-9-]+\.bandcamp\.com)',
                        '\1\2',
                        'i'
                      );

-- 2b. Staging links — rewrite the remaining www. rows ---------------
UPDATE public.artist_harvested_links
   SET parsed_url = regexp_replace(
                      parsed_url,
                      '^(https?://)www\.([a-z0-9-]+\.bandcamp\.com)',
                      '\1\2',
                      'i'
                    )
 WHERE parsed_platform = 'bandcamp'
   AND parsed_url ~* '^https?://www\.[a-z0-9-]+\.bandcamp\.com';
