-- Ad-hoc diagnostic version — superseded by the "SC followee duplicates"
-- report in the admin panel (/admin/reports), which runs this same
-- lookup as a paginated JS join instead of a single SQL query, to avoid
-- the Supabase SQL editor's upstream timeout on the two joins below.
-- Route: src/app/api/admin/reports/sc-followee-duplicates/route.ts
-- Kept here for ad-hoc use via a direct psql connection.
--
-- Find sc_followee artists whose SoundCloud permalink_url matches a URL
-- already held by an approved artist (in any platform, via artist_links).
--
-- Table/column names per supabase_schema_current.sql:
--   artists.directory_status (enum artist_status: 'sc_followee', 'approved', ...)
--   api_response_cache.payload (jsonb) -> 'permalink_url'  (namespace 'soundcloud_user',
--     cache_key = artist_id::text — this is where the raw SoundCloud user payload
--     lives since artist_enrichment.raw_data was moved out; see
--     supabase_migration_move_raw_data_to_cache.sql)
--   artist_links.url, artist_links.not_found (tombstone flag — excluded per project convention)
--
-- URL normalization: lowercased, strip scheme + "www.", strip trailing slash,
-- so "https://soundcloud.com/Foo/" and "http://www.soundcloud.com/foo" match.

WITH followees AS (
  SELECT
    a.id                          AS followee_id,
    a.name                        AS followee_name,
    c.payload ->> 'permalink_url' AS permalink_url,
    lower(
      regexp_replace(
        regexp_replace(c.payload ->> 'permalink_url', '^https?://(www\.)?', ''),
        '/+$', ''
      )
    ) AS norm_url
  FROM artists a
  JOIN api_response_cache c
    ON c.namespace = 'soundcloud_user'
   AND c.cache_key = a.id::text
  WHERE a.directory_status = 'sc_followee'
    AND c.payload ->> 'permalink_url' IS NOT NULL
),
approved_links AS (
  SELECT
    a.id                AS approved_id,
    a.name              AS approved_name,
    al.platform         AS approved_platform,
    al.url              AS approved_url,
    lower(
      regexp_replace(
        regexp_replace(al.url, '^https?://(www\.)?', ''),
        '/+$', ''
      )
    ) AS norm_url
  FROM artists a
  JOIN artist_links al ON al.artist_id = a.id
  WHERE a.directory_status = 'approved'
    AND al.not_found = false        -- exclude url-less tombstone rows
    AND al.url IS NOT NULL
)
SELECT
  f.followee_id,
  f.followee_name,
  f.permalink_url          AS followee_soundcloud_url,
  ap.approved_id,
  ap.approved_name,
  ap.approved_platform,
  ap.approved_url
FROM followees f
JOIN approved_links ap ON ap.norm_url = f.norm_url
ORDER BY f.followee_name;
