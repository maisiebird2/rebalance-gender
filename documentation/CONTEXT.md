# Project context — All Frequencies

Read this file at the start of any chat session to orient yourself. For
deeper detail, read the docs it points to.

---

## What this is

A Next.js + Supabase directory of women, femmes, and non-binary
producers/DJs in electronic music, live at allfrequencies.app. Visitors
can browse by genre and country, view individual artist pages, and submit
new artists via a moderation queue. An AI-powered recommendation engine
surfaces similar artists on each artist page.

---

## Tech stack

- **Frontend:** Next.js (App Router, TypeScript, Tailwind)
- **Database:** Supabase (PostgREST API — never raw SQL connections from
  the app)
- **Deployment:** Vercel
- **Domain:** `allfrequencies.app` (apex is canonical; `www` redirects to it),
  registered at Porkbun. The move from the previous name is recorded in
  [REBRAND-ALL-FREQUENCIES-v2.md](REBRAND-ALL-FREQUENCIES-v2.md).

---

## Environment variables (all in `.env.local`, never committed)

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | project API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server | read-only via RLS |
| `SUPABASE_SECRET_KEY` | server only | bypasses RLS; admin routes only |
| `ADMIN_EMAILS` | server only | comma-separated emails of auth users treated as admins (admin panel + all-statuses directory visibility); other signed-in users only get the edit form |
| `SOUNDCLOUD_CLIENT_ID` | scripts only | SC API credential |
| `SOUNDCLOUD_CLIENT_SECRET` | scripts only | SC API credential |
| `SPOTIFY_CLIENT_ID` | server + scripts | Spotify API credential (also missing-links suggestions) |
| `SPOTIFY_CLIENT_SECRET` | server + scripts | Spotify API credential (also missing-links suggestions) |
| `DISCOGS_TOKEN` | server only | Discogs personal access token, for missing-links suggestions. Alternative: the two below. |
| `DISCOGS_CONSUMER_KEY` / `DISCOGS_CONSUMER_SECRET` | server only | Discogs app credentials — either these or `DISCOGS_TOKEN` (token wins if both set) |

The Supabase client helpers live in `src/lib/supabase.ts`:
- `getSupabaseClient()` — public client, safe for browser and server components
- `getSupabaseAdminClient()` — uses `SUPABASE_SECRET_KEY`, server-only

---

## Key database tables

| Table | Purpose |
|---|---|
| `artists` | One row per artist. `directory_status` controls visibility (see below). |
| `artist_links` | Platform URLs (soundcloud, spotify, bandcamp, etc.) |
| `artist_enrichment` | Per-platform enriched data (bio, follower count, image URL, recent tracks) |
| `artist_genres` | Artist ↔ genre join. `genre_id` is a FK to `genres` — not a text column. |
| `genres` | Canonical genre list with `status` (pending/approved/deleted) |
| `artist_types` | Canonical role vocabulary (producer / DJ / vocalist): `name` slug, `label`, `sort_order`. Closed, hand-seeded — no `status`, unlike `genres`. |
| `artist_type_assignments` | Artist ↔ type join. Carries `source` (`'manual'`, or a platform key) and `created_at`; PK `(artist_id, type_id, source)` so one source's rows can be purged without touching others. Set manually via the edit form. |
| `artist_locations` | City + country per artist |
| `sc_follow_edges` | Directed SoundCloud follow graph (source_artist_id → followed_artist_id) |
| `mb_tags` | MusicBrainz folksonomy tags per artist |
| `mb_collaborations` | Artist pairs with MusicBrainz relationship edges |
| `artist_similarity_scores` | Computed pairwise recommendation scores (source → recommended) |
| `artist_harvested_links` | Staging table for links harvested from SC bios etc., before integration |
| `artist_labels` | Flat label/crew strings per artist. Superseded by `organisations` but **not** legacy — now the staging area for names not yet resolved to an organisation. (The older `artists.labels` text column it replaced was dropped in phase 6 of the organisations work.) |
| `organisations` | Record labels, clubs, crews, events. `status` (pending/approved/rejected/deleted), `duplicate_of` merge pointer, `name_search` generated key. `notes` is admin-only via column grants |
| `organisation_types` / `organisation_type_links` | Type vocabulary + many-to-many join — Tresor is a club *and* a label |
| `organisation_roles` | Role vocabulary: `associated`, `head`, `resident`, `A&R`… Editable from `/admin/settings` |
| `artist_organisations` | Artist ↔ organisation join, with `role_key` **in the primary key** so one artist can hold several roles at one organisation. Editable from both sides in the admin panel; public forms can only ever write `associated` |
| `organisation_locations` / `organisation_links` | Mirror `artist_locations` / `artist_links`; links share the same `platforms` lookup |

### `directory_status` values

| Value | Meaning |
|---|---|
| `approved` | Visible in the directory |
| `pending` | Submitted, awaiting moderation |
| `rejected` | Moderated out |
| `sc_followee` | Discovered via SoundCloud follow graph; not yet in directory |
| `search_input` | Name entered in a search that had no directory match; not yet in directory |
| `label_etc` | An organisation submitted through the artist form. The organisations backfill converted all 155 of these into `organisations` rows and soft-deleted the artist rows, so none are currently live |

---

## Frontend — key files

```
src/
  app/
    page.tsx                    # Homepage: directory listing with filters
    artist/[id]/page.tsx        # Artist detail page
    artist/[id]/edit/           # Artist edit form (auth-gated)
    organisation/[id]/page.tsx  # Public organisation page (noindexed for now)
    api/
      submit/route.ts           # POST — public artist submission
    admin/page.tsx              # Moderation queue (auth-gated)
    admin/missing-links/        # Find + fill artists' missing platform links (auth-gated)
    admin/organisations/        # Organisation list, moderation queue, edit + merge (auth-gated)
    api/admin/platform-search/  # GET — top-3 profile candidates on an external platform
    submit/page.tsx             # Submission form
  components/
    ArtistCard.tsx              # Card used in directory listing; optional `footer` slot
    RecommendedArtists.tsx      # "You might also like" strip on artist pages
    FilterBar.tsx               # Genre/country/search filters + exact-match toggle
    BandcampWidget.tsx          # Embedded Bandcamp player
    form/OrganisationList.tsx   # The Organisations field, shared by submit/revise/edit.
                                # <input list> + <datalist> over approved organisations;
                                # a role picker appears only when `roles` is passed (admin)
  lib/
    supabase.ts                 # Supabase client helpers
    queries.ts                  # All data-fetching functions (inc. getRecommendedArtists)
    types.ts                    # TypeScript types mirroring DB schema
    platforms.ts                # Platform label helpers + search-URL builder
    search-providers.ts         # Server-only per-platform artist search (missing-links)
    profile-links.ts            # Link normalization + handle derivation (shared save paths)
    name-key.mjs                # normalisedNameKey / unaccent — the ONE name_search key, shared with scripts/
    unaccent-delta.generated.mjs # generated from Postgres by scripts/generate-unaccent-delta.mjs
    organisations.ts            # Role grouping, form seeding
    organisation-writes.ts      # Server-side organisation writes shared by /api/submit and the admin approval paths
    linkify.ts                  # URL linkification for bios
```

---

## Missing-links admin page (`/admin/missing-links`)

Auth-gated tool for filling gaps in `artist_links`. Pick a platform from
the dropdown → cards (shared `ArtistCard` with a `footer` slot) list
approved artists with **no** `artist_links` row for it (a `not_found:
true` row counts as handled). The anti-join lives in
`getArtistsMissingLink()` in `src/lib/queries.ts`.

Each card offers, in order of convenience:

1. **Inline suggestions** — top 3 profile candidates fetched from the
   platform's API via `src/lib/search-providers.ts` (providers: discogs,
   musicbrainz, spotify, bandcamp; each degrades to nothing if its env
   keys are missing). Served by `/api/admin/platform-search`;
   card fetches are staggered client-side for rate limits (MusicBrainz
   1 req/s). Ticking a candidate saves it.
2. **Manual paste field** — for URLs found by hand.
3. **Search link** — e.g. "Discogs search for PHLOXO", built from
   `platforms.search_url_template` (`{query}` placeholder; added by
   `supabase_migration_platform_search_templates.sql`). Only platforms
   with a template appear in the dropdown.
4. **"Not on {platform}"** — writes a `not_found: true` row so the
   artist stops appearing.

Saves go through `saveArtistPlatformLink()` (`admin/missing-links/actions.ts`),
which reuses the edit form's normalization (`resolveProfileLinkUrl` →
`cleanLinkUrl` → `deriveHandle`) and triggers image enrichment for
image-capable platforms.

---

## Directory search performance

The homepage name search matches substrings against the `name_search`
generated column: unaccented, lowercased, then everything that isn't
`[a-z0-9]` removed — so spaces AND punctuation go. Postgres computes it via
`public.normalise_name_key()`, and the app computes the same key for the
search term via `normalisedNameKey()` in `src/lib/name-key.mjs`; see
"The normalised name key" below for why that is one shared module and not
a reimplementation. Two design decisions keep it fast even though the
`artists` table is dominated by non-directory graph nodes
(`sc_followee` / `search_input` rows):

- **Partial trigram index** — a `pg_trgm` GIN index on `name_search`,
  restricted to `directory_status = 'approved' AND deleted = false`
  (`supabase_migration_search_indexes.sql`). It serves `%term%` ILIKE
  lookups and only covers the actual directory, so follow-graph growth
  doesn't slow search. Any query that wants this index must include
  both filter conditions.
- **Exact match** — the "Exact match" checkbox in `FilterBar` sets
  `?exact=1`, which narrows the search from `%term%` to the bare `term`,
  so "Vel" finds the artist Vel and not "Velvet Underground". It stays an
  ILIKE rather than becoming an `=` so the same trigram index still serves
  it (the GIN opclass indexes LIKE/ILIKE patterns, not equality), and a
  wildcard-free ILIKE *is* equality here: both sides are already lowercase
  `[a-z0-9]` after `normalisedNameKey()`, which also means no `%` or `_` can
  reach the pattern as a wildcard. Matching stays on the normalised key,
  so exact ignores case, accents, spacing and punctuation — "V.E.L" still
  matches "Vel". Aliases are matched the same way. An exact miss offers a
  link to re-run the search without the constraint before offering to add
  the name to the review queue.
- **No exact result counts** — directory queries return `hasMore`
  (fetch `PAGE_SIZE + 1` rows, check for the extra) instead of a
  `count: "exact"` total, which would force a second full scan of all
  matches. Pagination is Previous/Next only; the UI doesn't show
  "N artists" or total pages.

### The normalised name key

Every place that compares a typed-in name against a stored one — the
directory search, the organisation duplicate check, the admin filters, the
`/api/search-miss` existence check, the HÖR and Discogs matchers — needs the
same key that Postgres stores in `name_search`. There is exactly one
definition on each side:

- **Postgres** — `public.normalise_name_key(text)`, called by the generated
  `name_search` column on `artists`, `artist_aliases` and `organisations`
  (`supabase_migration_normalise_name_key_function.sql`).
- **JavaScript** — `normalisedNameKey()` in `src/lib/name-key.mjs`, imported
  by the app and by `scripts/`. It is `.mjs` rather than `.ts` precisely so
  both can share it: TypeScript imports it, and the scripts run it under bare
  `node`.

The hard part is `unaccent()`. It is not an algorithm — it is contrib
`unaccent`'s lookup table — so JavaScript cannot derive it. NFD decomposition
handles the accented letters that are canonically "base letter + combining
mark" (é, ü, ż), which is most of them, and that is what the app used to do.
It fails silently on letters carrying the mark *inside* the codepoint: NFD
leaves `Ø` intact, the `[^a-z0-9]` strip then deletes it, and a search for
"ØTTA" went looking for `tta` — returning every artist with those letters
anywhere in their name while the stored key was the correct `otta`. `Ø æ œ ß
ł đ ð þ` and the rest of that family all failed the same way.

So the exceptions are **not hand-written**. `unaccent-delta.generated.mjs`
holds the characters where Postgres and NFD disagree about the final key,
generated by asking the database:

```
npm run generate-unaccent-delta
```

`src/lib/name-key.test.ts` then checks the assembled function against the
same database across every character in the BMP. That test is skipped unless
`SUPABASE_DB_URL` is in the environment:

```
set -a && . ./.env.local && set +a && npm test
```

Run it after applying the migration, after regenerating the table, and after
any Postgres major-version upgrade — `unaccent.rules` ships with the server
and does change between versions.

Two rules for callers:

- **Never reimplement the key.** Import it. The bug above existed because the
  expression had been copy-pasted into five places.
- **Treat an empty key as "no usable term", never as a wildcard.** A name
  written entirely in a script `unaccent()` cannot romanise ("МОЛЧАТ ДОМА")
  normalises to `""`, and so does its stored `name_search`. Passing that to
  an ILIKE builds `%%`, which matches every row — `getArtists()` returns an
  empty page for such a term instead.

### Grid select and random sampling

The homepage grid renders `ArtistCard`, which reads only a handful of
fields, so it uses the lean `CARD_SELECT` (id, name, pronoun, genres,
locations, aliases, images) rather than the full `ARTIST_SELECT` — it no
longer joins or ships `enrichment` bios, `artist_links`, `bandcamp_albums`,
or labels for the 24 tiles per page. `getRandomArtists()` samples in
Postgres via the `random_approved_artist_ids()` RPC
(`supabase_migration_random_approved_artists.sql`) instead of fetching
every approved id and shuffling in Node; `hasMore` comes from the
precomputed `approved_artist_count` in `site_stats`.

### Planned page-load work (not yet implemented)

Three follow-on backend changes were identified alongside the grid/sampling
work above but not yet built. None removes any frontend functionality:

- **Cache `getCountryOptions()`** — it is the only filter-options query
  still not wrapped in `unstable_cache`. `getGenreOptions()` /
  `getGenrePickerOptions()` cache their results (`revalidate: 600`), but
  `getCountryOptions()` re-runs its `artist_locations`→`artists` join on
  every homepage load. Wrap it the same way, with a tag so it can be
  revalidated when locations change.
- **Composite partial index on the approved subset** — add
  `CREATE INDEX ... ON artists (name) WHERE directory_status = 'approved'
  AND deleted = false`, mirroring the partial trigram index above. Every
  ordered directory query filters on exactly those two conditions with
  `ORDER BY name`, and the new `ORDER BY random()` sample scans the same
  subset. A partial b-tree lets all of them touch only the ~1.5k directory
  rows instead of merging the separate `idx_artists_directory_status` /
  `idx_artists_deleted` indexes across the graph-node bloat.
- **Precompute genre counts into `site_stats`** — `computeGenreOptions()`
  pages through every `artist_genres` link and counts in JS on each cold
  recompute (cached 600s, but expensive when it misses). Follow the
  `approved_artist_count` pattern (`supabase_migration_site_stats.sql`,
  refreshed by pg_cron): store per-genre approved counts and read them
  directly, so the ≥3-approved-artists filter no longer scans the whole
  junction table.

---

## Enrichment pipeline

Scripts live in `scripts/` and run from the repo root with `npm run <name>`
(or `node scripts/<name>.mjs` for scripts not yet in `package.json`).

**Read `PIPELINE.md` for the full ordered pipeline.** Summary:

| Phase | What it does |
|---|---|
| 0 | Initial CSV load (`migrate.mjs`) |
| 1 | Data quality — clean names, fix URLs |
| 2 | SoundCloud enrichment — bio, follower count, image, platform links |
| 3 | Bio processing — sanitize HTML, linkify |
| 4 | Profile images |
| 5 | Additional platforms (Bandcamp, Beatport) |
| 6 | External matching — MusicBrainz IDs, Spotify |
| 7 | Recommendation signals — SC follow graph, MB tags, genre harvesting |
| 8 | Review and data quality passes |

**Read `GENRES.md`** for how genres are harvested, normalised,
deduplicated/pruned, and displayed (the ≥3-approved-artists filter rule).

Python scripts (scoring pipeline) require conda; packages:
`conda install numpy pandas requests charset-normalizer`

---

## Recommendation engine

**Read `SCORING.md` for full detail.** Summary:

Three-step pipeline, all run from the repo root:

```bash
# 1. Compute raw signal scores for all artist pairs → CSV cache
python scripts/compute-scores.py --refresh

# 2. (No weight-tuning step. tune-weights.py grid-searched these weights
#     against a Last.fm similar-artist validation set; both were removed
#     with the rest of the Last.fm data. The weights below are the
#     hard-coded ones in compute-scores.mjs until a new validation set
#     exists.)

# 3. Apply best weights and push scores to DB
python scripts/push-scores.py --genre=X --mb-tag=X --mb-collab=X --direct-follow=X --co-follow=X
```

Five signals: `genre_score`, `mb_tag_score`, `mb_collab_score`,
`sc_direct_follow_score`, `sc_co_follow_score`.

Cache files (gitignored): `.cache/signals.json`, `.cache/pair-scores.csv`.

Current coverage gaps (as of June 2026): SC follow graph ~11% complete,
MB tags 0% (enrichment not run), genres 21%. See `IMPROVEMENT_PLAN.md`
for the remediation plan.

---

## Authentication

Login, sign-out, and password recovery for the admin/edit side (Supabase
Auth, email + password, no public sign-up), plus the Supabase dashboard
config and Resend SMTP setup that auth emails depend on.

**Read `OPERATIONS.md` for full detail** (backend/ops setup runbook; auth is
its first section), including the password-reset flow
(`/reset-password`), the "Forgot password?" login trigger, required Site
URL / Redirect URL / email-template settings, and how to point auth emails
at Resend SMTP to avoid the built-in "email rate limit exceeded" cap.

---

## Conventions

- PostgREST pagination: Supabase returns max 1000 rows per request;
  scripts that need all rows must loop with offset.
- Pair keys in scoring: always lower UUID first (canonical ordering).
- Never use `--break-system-packages` with pip; use conda environments.
- Never run git write commands autonomously — provide commands for Maisie
  to run herself.
- Inclusive language: avoid whitelist/blacklist; use allowlist/denylist.
