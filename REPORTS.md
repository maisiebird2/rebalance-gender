# Admin reports

The admin **Reports** page (`/admin/reports`) is a small collection of one-off
diagnostic reports. Each is registered in [`src/lib/reports.ts`](src/lib/reports.ts)
and rendered as a card by [`src/app/admin/reports/page.tsx`](src/app/admin/reports/page.tsx)
via [`ReportButton.tsx`](src/app/admin/reports/ReportButton.tsx). The page is
auth-guarded like the rest of `/admin`.

There are two kinds of report:

| kind | button | what it does |
| --- | --- | --- |
| `download` | **Download .ods** | Fetches an auth-guarded route under `/api/admin/reports/` that builds a LibreOffice/OpenDocument spreadsheet server-side and streams it. |
| `sql` | **Copy SQL** | Copies a SQL query to the clipboard to paste into the Supabase SQL editor. For queries too heavy to run inside a serverless function's time budget. |

---

## Harvest failures (`download`)

**What:** every current row in `harvest_failures` — one row per artist + service
that failed to harvest — with the `artist_id` replaced by the artist's name,
hyperlinked to their edit page. Columns: artist, URL, status, detail, service,
occurred at.

**How:** [`/api/admin/reports/harvest-failures`](src/app/api/admin/reports/harvest-failures/route.ts)
pages through `harvest_failures` (embedding `artists` via the
`harvest_failures_artist_id_fkey` FK) and builds the `.ods`. The table is small,
so a plain server-side download is fine here.

---

## SC followee duplicates (`sql`)

**What:** `sc_followee` artists whose SoundCloud profile URL matches a link
already held by an `approved` artist — i.e. likely the same person, discovered a
second time via the SoundCloud follow graph. Columns: followee id/name/URL,
approved id/name/platform/URL.

**Why it's a "Copy SQL" report and not a download.** This one matches ~133k
`sc_followee` artists against ~135k cached SoundCloud profiles. Run as a
serverless download it repeatedly blew up:

- Reading the SoundCloud permalink out of the `api_response_cache.payload` JSONB
  **detoasts** the large blob for every row. Fixed by a generated column,
  `api_response_cache.permalink_url`
  ([`supabase_migration_cache_permalink_url.sql`](supabase_migration_cache_permalink_url.sql)),
  which materializes `payload->>'permalink_url'` as a cheap text column.
- Even then, paging ~135k rows over PostgREST (hard-capped at 1000 rows/request)
  is ~135 sequential round-trips. That ran ~30s+ and tripped Postgres'
  `statement_timeout` / exceeded a **Vercel Hobby function's 60s cap**.

The same match runs in **~20s as a single query in the Supabase SQL editor**
(2-minute limit), returning only the handful of matched rows. So the report
hands you that query instead of trying to run it in a route.

**The query** lives in two places, kept in sync:
[`scripts/find-sc-followee-duplicates.sql`](scripts/find-sc-followee-duplicates.sql)
(canonical, for `psql`/documentation) and the `sql` string in
[`src/lib/reports.ts`](src/lib/reports.ts) (what the button copies).

**To run it:** open the Reports page → **Copy SQL** on this card → paste into the
Supabase SQL editor → run.

**Gotcha — URL normalization.** SoundCloud permalinks carry a `?utm_…` query
string that the approved artists' `artist_links` URLs don't. Both sides must be
normalized (strip scheme, `www.`, the query/fragment, and any trailing slash) or
essentially nothing matches. That normalization is in the query.

---

## Adding a report

Append an entry to `REPORTS` in [`src/lib/reports.ts`](src/lib/reports.ts):

- **`download`**: set `kind: "download"` and `endpoint`, then add the matching
  route under `src/app/api/admin/reports/<slug>/`. Fine for small result sets.
- **`sql`**: set `kind: "sql"` and `sql`. Self-contained — no route needed.
  Prefer this when the query would scan large tables or exceed the serverless
  time budget.

The page and buttons pick up new entries automatically.
