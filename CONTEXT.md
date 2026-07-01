# Project context — Women in Electronic Music directory

Read this file at the start of any chat session to orient yourself. For
deeper detail, read the docs it points to.

---

## What this is

A Next.js + Supabase directory of women, femmes, and non-binary
producers/DJs in electronic music, live at rebalance-gender.com. Visitors
can browse by genre and country, view individual artist pages, and submit
new artists via a moderation queue. An AI-powered recommendation engine
surfaces similar artists on each artist page and on a `/discover` page
where visitors can search by any artist name or URL.

---

## Tech stack

- **Frontend:** Next.js (App Router, TypeScript, Tailwind)
- **Database:** Supabase (PostgREST API — never raw SQL connections from
  the app)
- **Deployment:** Vercel
- **Domain registrar:** Porkbun

---

## Environment variables (all in `.env.local`, never committed)

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | project API URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server | read-only via RLS |
| `SUPABASE_SECRET_KEY` | server only | bypasses RLS; admin routes only |
| `SOUNDCLOUD_CLIENT_ID` | scripts only | SC API credential |
| `SOUNDCLOUD_CLIENT_SECRET` | scripts only | SC API credential |
| `SPOTIFY_CLIENT_ID` | scripts only | Spotify API credential |
| `SPOTIFY_CLIENT_SECRET` | scripts only | Spotify API credential |
| `LASTFM_API_KEY` | server + scripts | Last.fm API key; no `NEXT_PUBLIC_` prefix |

The Supabase client helpers live in `src/lib/supabase.ts`:
- `getSupabaseClient()` — public client, safe for browser and server components
- `getSupabaseAdminClient()` — uses `SUPABASE_SECRET_KEY`, server-only

---

## Key database tables

| Table | Purpose |
|---|---|
| `artists` | One row per artist. `directory_status` controls visibility (see below). |
| `artist_links` | Platform URLs (soundcloud, lastfm, spotify, etc.) |
| `artist_enrichment` | Per-platform enriched data (bio, follower count, image URL, recent tracks) |
| `artist_genres` | Artist ↔ genre join. `genre_id` is a FK to `genres` — not a text column. |
| `genres` | Canonical genre list with `status` (pending/approved/deleted) |
| `artist_locations` | City + country per artist |
| `sc_follow_edges` | Directed SoundCloud follow graph (source_artist_id → followed_artist_id) |
| `mb_tags` | MusicBrainz folksonomy tags per artist |
| `mb_collaborations` | Artist pairs with MusicBrainz relationship edges |
| `lastfm_similar_artists` | Raw LFM similar-artist data; `similar_artist_id` is resolved to our DB where possible |
| `artist_similarity_scores` | Computed pairwise recommendation scores (source → recommended) |
| `artist_harvested_links` | Staging table for links harvested from SC bios etc., before integration |

### `directory_status` values

| Value | Meaning |
|---|---|
| `approved` | Visible in the directory |
| `pending` | Submitted, awaiting moderation |
| `rejected` | Moderated out |
| `sc_followee` | Discovered via SoundCloud follow graph; not yet in directory |
| `lfm_search` | Discovered via `/discover` search; not yet in directory |

---

## Frontend — key files

```
src/
  app/
    page.tsx                    # Homepage: directory listing with filters
    discover/page.tsx           # /discover — search for similar artists (client component)
    artist/[id]/page.tsx        # Artist detail page
    artist/[id]/edit/           # Artist edit form (auth-gated)
    api/
      submit/route.ts           # POST — public artist submission
      discover/route.ts         # POST — discover similar artists via LFM + genre matching
    admin/page.tsx              # Moderation queue (auth-gated)
    submit/page.tsx             # Submission form
  components/
    ArtistCard.tsx              # Card used in directory listing
    RecommendedArtists.tsx      # "You might also like" strip on artist pages
    FilterBar.tsx               # Genre/country/search filters
    BandcampWidget.tsx          # Embedded Bandcamp player
  lib/
    supabase.ts                 # Supabase client helpers
    queries.ts                  # All data-fetching functions (inc. getRecommendedArtists)
    types.ts                    # TypeScript types mirroring DB schema
    platforms.ts                # Platform label helpers
    linkify.ts                  # URL linkification for bios
```

---

## Enrichment pipeline

Scripts live in `scripts/` and run from the repo root with `npm run <name>`
(or `node scripts/<name>.mjs` for scripts not yet in `package.json`).

**Read `scripts/PIPELINE.md` for the full ordered pipeline.** Summary:

| Phase | What it does |
|---|---|
| 0 | Initial CSV load (`migrate.mjs`) |
| 1 | Data quality — clean names, fix URLs |
| 2 | SoundCloud enrichment — bio, follower count, image, platform links |
| 3 | Bio processing — sanitize HTML, linkify |
| 4 | Profile images |
| 5 | Additional platforms (Bandcamp, Beatport) |
| 6 | External matching — Last.fm similar artists, MusicBrainz IDs, Spotify |
| 7 | Recommendation signals — SC follow graph, MB tags, genre harvesting |
| 8 | Review and data quality passes |

Python scripts (scoring pipeline) require conda; packages:
`conda install numpy pandas requests charset-normalizer`

---

## Recommendation engine

**Read `scripts/SCORING.md` for full detail.** Summary:

Three-step pipeline, all run from the repo root:

```bash
# 1. Compute raw signal scores for all artist pairs → CSV cache
python scripts/compute-scores.py --refresh

# 2. Grid-search weight combinations against Last.fm validation set
python scripts/tune-weights.py

# 3. Apply best weights and push scores to DB
python scripts/push-scores.py --genre=X --mb-tag=X --mb-collab=X --direct-follow=X --co-follow=X
```

Five signals: `genre_score`, `mb_tag_score`, `mb_collab_score`,
`sc_direct_follow_score`, `sc_co_follow_score`.

Cache files (gitignored): `.cache/signals.json`, `.cache/pair-scores.csv`.

Current coverage gaps (as of June 2026): SC follow graph ~11% complete,
MB tags 0% (enrichment not run), genres 21%. See `scripts/IMPROVEMENT_PLAN.md`
for the remediation plan.

---

## `/discover` page

Accepts an artist name, Last.fm URL, or SoundCloud URL. Calls Last.fm
`artist.getSimilar` + `artist.getTopTags`, matches against directory
artists via their LFM links and genre overlap, returns top 10. Artists
not in the directory that are searched for are saved as stubs with
`directory_status = 'lfm_search'` (demand signal for future outreach).

---

## Conventions

- PostgREST pagination: Supabase returns max 1000 rows per request;
  scripts that need all rows must loop with offset.
- Pair keys in scoring: always lower UUID first (canonical ordering).
- Never use `--break-system-packages` with pip; use conda environments.
- Never run git write commands autonomously — provide commands for Maisie
  to run herself.
- Inclusive language: avoid whitelist/blacklist; use allowlist/denylist.
