// src/lib/reports.ts
//
// Registry of admin "Reports" rendered by the admin Reports page
// (src/app/admin/reports/page.tsx), one card per entry. There are two kinds:
//
//   - kind: "download" — a button that fetches an auth-guarded API route under
//     /api/admin/reports/ and downloads the LibreOffice/OpenDocument (.ods)
//     spreadsheet it streams.
//
//   - kind: "sql" — a button that copies a SQL query to the clipboard, to be
//     pasted into the Supabase SQL editor. Used when the query is too heavy to
//     run inside a serverless function's time budget (see the sc-followee-
//     duplicates entry and REPORTS.md).
//
// To add a report: append an entry here. A "download" entry also needs a
// matching route; a "sql" entry is self-contained.

interface BaseReport {
  /** Stable slug — matches the API route segment / used as a React key. */
  slug: string;
  /** Short title shown on the card. */
  title: string;
  /** One-line description of what the report contains. */
  description: string;
}

export interface DownloadReport extends BaseReport {
  kind: "download";
  /** GET endpoint that streams the .ods download. */
  endpoint: string;
}

export interface SqlReport extends BaseReport {
  kind: "sql";
  /** SQL to copy to the clipboard for the Supabase SQL editor. */
  sql: string;
}

export type ReportDefinition = DownloadReport | SqlReport;

// The SC-followee-duplicates query. Kept in sync with
// scripts/find-sc-followee-duplicates.sql (the "Copy SQL" button copies this).
// Run it in the Supabase SQL editor — it scans ~135k cache rows (~20s), which
// is fine there but exceeds a Vercel Hobby function's 60s cap, so we hand over
// the SQL rather than run it in a route. Requires the
// api_response_cache.permalink_url generated column
// (supabase_migration_cache_permalink_url.sql).
const SC_FOLLOWEE_DUPLICATES_SQL = `WITH followees AS (      -- Set 1: sc_followees + their SoundCloud permalink
  SELECT
    a.id   AS followee_id,
    a.name AS followee_name,
    c.permalink_url AS followee_url,
    lower(regexp_replace(regexp_replace(regexp_replace(
      btrim(c.permalink_url), '^https?://(www\\.)?', '', 'i'),  -- strip scheme + www
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
      btrim(al.url), '^https?://(www\\.)?', '', 'i'),
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
`;

export const REPORTS: ReportDefinition[] = [
  {
    kind: "download",
    slug: "harvest-failures",
    title: "Harvest failures",
    description:
      "Every current harvest failure (one row per artist + service), with the artist name linked to their edit page. Columns: artist, URL, status, detail, service, occurred at.",
    endpoint: "/api/admin/reports/harvest-failures",
  },
  {
    kind: "sql",
    slug: "sc-followee-duplicates",
    title: "SC followee duplicates",
    description:
      "sc_followee artists whose SoundCloud URL matches a link already held by an approved artist — likely the same person, discovered a second time via the follow graph. Copies a SQL query to your clipboard; paste it into the Supabase SQL editor and run it there (it's too slow to run in the app). Columns: followee id/name/URL, approved id/name/platform/URL.",
    sql: SC_FOLLOWEE_DUPLICATES_SQL,
  },
];
