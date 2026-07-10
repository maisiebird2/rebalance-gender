-- Find sc_followee artists whose SoundCloud permalink_url matches a URL
-- already held by an approved artist (in any platform, via artist_links).
--
-- Table/column names per supabase_schema_current.sql:
--   artists.directory_status (enum artist_status: 'sc_followee', 'approved', ...)
--   artist_enrichment.raw_data (jsonb) -> 'permalink_url'
--   artist_links.url, artist_links.not_found (tombstone flag — excluded per project convention)
--
-- URL normalization: lowercased, strip scheme + "www.", strip trailing slash,
-- so "https://soundcloud.com/Foo/" and "http://www.soundcloud.com/foo" match.

WITH followees AS (
  SELECT
    a.id                          AS followee_id,
    a.name                        AS followee_name,
    ae.raw_data ->> 'permalink_url' AS permalink_url,
    lower(
      regexp_replace(
        regexp_replace(ae.raw_data ->> 'permalink_url', '^https?://(www\.)?', ''),
        '/+$', ''
      )
    ) AS norm_url
  FROM artists a
  JOIN artist_enrichment ae ON ae.artist_id = a.id
  WHERE a.directory_status = 'sc_followee'
    AND ae.platform = 'soundcloud'          -- avoid detoasting raw_data for every other platform row
    AND ae.raw_data ->> 'permalink_url' IS NOT NULL
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
