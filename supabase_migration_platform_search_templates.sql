-- Adds a per-platform search URL template to the `platforms` lookup table.
-- Used by the admin "Missing links" page (/admin/missing-links) to build a
-- "search this platform for <artist>" link on each artist card.
--
-- Template convention: `{query}` is replaced with the URL-encoded artist
-- name (see buildPlatformSearchUrl in src/lib/platforms.ts). Platforms with
-- a NULL template simply don't appear in the missing-links dropdown.
--
-- Run in the Supabase SQL editor. Safe to re-run: the ADD COLUMN is
-- IF NOT EXISTS and the UPDATEs are no-ops for keys that don't exist.

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS search_url_template text;

UPDATE public.platforms AS p
SET search_url_template = t.template
FROM (VALUES
  ('discogs',          'https://www.discogs.com/search?q={query}&type=all'),
  ('bandcamp',         'https://bandcamp.com/search?q={query}&item_type=b'),
  ('soundcloud',       'https://soundcloud.com/search/people?q={query}'),
  ('spotify',          'https://open.spotify.com/search/{query}/artists'),
  ('youtube',          'https://www.youtube.com/results?search_query={query}'),
  ('musicbrainz',      'https://musicbrainz.org/search?query={query}&type=artist'),
  ('lastfm',           'https://www.last.fm/search/artists?q={query}'),
  ('beatport',         'https://www.beatport.com/search?q={query}'),
  ('qobuz',            'https://www.qobuz.com/us-en/search?q={query}'),
  ('resident_advisor', 'https://ra.co/search?searchValue={query}'),
  ('instagram',        'https://www.instagram.com/explore/search/keyword/?q={query}')
) AS t(key, template)
WHERE p.key = t.key
  AND p.search_url_template IS DISTINCT FROM t.template;
