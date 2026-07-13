-- SC followee duplicates — sc_followee artists whose SoundCloud profile matches
-- a URL already held by an approved artist (likely the same person, found a
-- second time via the follow graph).
--
-- This is the query the admin Reports page's "SC followee duplicates" report
-- copies to your clipboard ("Copy SQL" button). Paste it into the Supabase SQL
-- editor and run it there — it scans ~135k cache rows and takes ~20s, which is
-- fine for the SQL editor (2-min limit) but too slow for a Vercel serverless
-- function on the Hobby plan, so we surface the SQL instead of running it in a
-- route. See REPORTS.md for the full story.
--
-- Keep this in sync with the SQL string in src/lib/reports.ts (the button copies
-- that copy).
--
-- Requires the api_response_cache.permalink_url generated column
-- (supabase_migration_cache_permalink_url.sql): the SoundCloud permalink lives
-- in the payload JSONB, and reading it via that column avoids detoasting every
-- row.
--
-- Note on normalization: SoundCloud permalinks carry a "?utm_…" query string
-- that the approved artists' links don't, so both sides must be normalized
-- (scheme, "www.", query/fragment, and trailing slash stripped) or nothing
-- matches.

WITH followees AS (      -- Set 1: sc_followees + their SoundCloud permalink
  SELECT
    a.id   AS followee_id,
    a.name AS followee_name,
    c.permalink_url AS followee_url,
    lower(regexp_replace(regexp_replace(regexp_replace(
      btrim(c.permalink_url), '^https?://(www\.)?', '', 'i'),  -- strip scheme + www
      '[?#].*$', ''),                                           -- strip ?utm…/fragment
      '/+$', '')) AS norm_url                                   -- strip trailing slash
  FROM artists a
  JOIN api_response_cache c
    ON c.namespace = 'soundcloud_user'
   AND c.cache_key = a.id::text
  WHERE a.directory_status = 'sc_followee'
    AND a.deleted = false
    AND c.permalink_url IS NOT NULL
),
approved AS (            -- Set 2: approved artists + all their platform links
  SELECT
    a.id   AS approved_id,
    a.name AS approved_name,
    al.platform AS approved_platform,
    al.url AS approved_url,
    lower(regexp_replace(regexp_replace(regexp_replace(
      btrim(al.url), '^https?://(www\.)?', '', 'i'),
      '[?#].*$', ''),
      '/+$', '')) AS norm_url
  FROM artists a
  JOIN artist_links al ON al.artist_id = a.id
  WHERE a.directory_status = 'approved'
    AND a.deleted = false
    AND al.not_found = false
    AND al.url IS NOT NULL
)
SELECT
  f.followee_id, f.followee_name, f.followee_url,
  ap.approved_id, ap.approved_name, ap.approved_platform, ap.approved_url
FROM followees f
JOIN approved ap ON ap.norm_url = f.norm_url
ORDER BY f.followee_name;
