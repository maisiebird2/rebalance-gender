# Enrichment Pipeline

This document describes the logical order in which the enrichment
scripts should be run, and the purpose of each. The goal is to
eventually have a single `orchestrate.mjs` script that calls each
stage in order.

---

## Overview

```
Phase 0 │ Initial load (run once)
Phase 1 │ Data quality
Phase 2 │ Platform link & profile harvesting (SoundCloud + direct links)
Phase 3 │ External matching fallback (Last.fm, MusicBrainz, Spotify)
Phase 4 │ Bio processing
Phase 5 │ Profile images
Phase 6 │ Discography enrichment (Bandcamp)
Phase 7 │ Recommendation engine signals
Phase 8 │ Review / data quality
```

Artists enter the database through **two entry points**: the one-time
bulk CSV load (Phase 0), and continuously via the website's
submission/revision flow (see "Ongoing entry point" below, after
Phase 8). The enrichment phases currently only run as bulk scripts,
so artists arriving through the website sit with entry-form data
only (plus an auto-fetched profile image) until the next manual
pipeline run — closing that gap is the goal of the planned
orchestration work.

---

## Orchestration

Phases 1–2 (plus the Bandcamp discography step, Phase 6) can be run end
to end with a single command via `orchestrate-platform-enrichment.mjs`:

```bash
npm run orchestrate-platform-enrichment -- --approved
```

It runs, in dependency order: `clean-artist-names` (Phase 1) →
`enrich-soundcloud` (2a) → `harvest-soundcloud-links-and-bio` (2b) →
`harvest-links-loop` (the 2c+2d convergence loop) → `enrich-bandcamp`
(Phase 6, run last since it depends on Bandcamp links that 2d may have
just promoted). Each stage tracks its own processed state in the
database, so the orchestrator holds no state and is safe to re-run — a
second run only touches artists with new data.

`--approved` restricts every stage to directory artists
(`directory_status = 'approved'`, excluding deleted). It is forwarded to
each child stage, and `harvest-links-loop` forwards it again to its own
children, so one flag governs the whole loop. `clean-artist-names` is a
global name cleanup, so it is the one stage `--approved` is not passed
to. `DRY_RUN=1` (no writes anywhere) and an optional `--max-rounds=N`
(caps the convergence loop) are also honored.

This is the first concrete piece of the "eventual `orchestrate.mjs`"
referenced throughout this doc; later phases can be folded in as
additional stages.

---

## Phase 0 — Initial load *(run once)*

### `migrate.mjs`
Loads the master CSV (`women, femmes, enbies of electronic music - list (genres normalized).csv`)
into the database: artists, genres, locations, and platform links.
Also seeds the `pronouns` lookup from `pronouns_lookup.csv`
(`artists.pronoun_id` references it). Run once when setting up a
fresh database. Refuses to run if `artists` already has rows (to
prevent duplicates).

Prerequisite reference table: **`platforms`** `(key, label,
sort_order)` defines the valid values for `artist_links.platform`
and must be populated before any link-writing phase (2, 3) —
`integrate-harvested-links.mjs` validates keys against it. It is
not seeded by `migrate.mjs`; rows are managed in the admin settings
page (`src/app/admin/actions.ts`).

```bash
DRY_RUN=1 npm run migrate   # verify first
npm run migrate
```

---

## Phase 1 — Data quality

### `clean-artist-names.mjs`
Strips invisible Unicode characters (zero-width marks, control
characters, etc.) and whitespace from the start and end of every
artist name. Should be run after any import or bulk update, and
before enrichment scripts that use names as search queries.

```bash
npm run clean-artist-names
```

---

## Phase 2 — Platform link & profile harvesting

Principle: **gather every platform link we can from artist pages
directly, before relying on inferred matches.** Direct links found
on an artist's own profiles (SoundCloud web-profiles, Discogs,
Bandcamp, Linktree) are ground truth; the best-match resolution in
Phase 3 is the fallback for whatever this phase doesn't find.
Since platforms link to yet other platforms — including Last.fm,
Spotify, and MusicBrainz — a thorough pass here fills out the
artist's platform picture for everything downstream (images, bios,
matching, genres) and shrinks the set of artists that need
best-match guessing at all.

2a and 2b pull from SoundCloud (and are slated to be merged into a
single stage — see "Planned changes"); 2c is the direct-link
harvesters; 2d–2e promote and clean.

### 2a. `enrich-soundcloud.mjs`
Uses the official SoundCloud API to fetch each artist's profile
data: bio, follower count, track count, profile image URL, and
numeric user ID. Writes to `artist_enrichment` (platform = `soundcloud`).

Processed state is tracked in the database (`resolved_artists`,
service = `soundcloud-enrich`), not a cache file — per project
convention. An artist is skipped once a state row exists; re-runs
only touch artists that haven't been marked done. A resolve failure
only marks an artist processed on a definitive dead link (404);
transient failures (timeouts, rate limits, DB write errors) are left
unmarked so the next run retries them.

```bash
npm run enrich-soundcloud
npm run enrich-soundcloud -- --approved   # directory artists only
npm run enrich-soundcloud -- --force      # re-process even artists with existing state
```

`--approved` restricts the run to directory artists (`directory_status = 'approved'`, excluding deleted) rather than every artist with a SoundCloud link (mostly unvetted `sc_followee` follow-graph nodes).

Requires `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET` in `.env.local`.

### 2b. `harvest-soundcloud-links-and-bio.mjs`
Uses the official SoundCloud API (`/users/{urn}/web-profiles`) to
fetch each artist's platform links (Instagram, Spotify, Bandcamp,
etc.) from the "Links" section of their SoundCloud profile. Writes
to the `artist_harvested_links` staging table — does not touch
`artist_links` directly. Also fetches bios, which are staged in
`artist_harvested_bios` (note: no script currently promotes staged
bios — live bios reach `artist_enrichment` via `enrich-soundcloud.mjs`
in 2a instead).

Processed state uses the same `resolved_artists` pattern as 2a
(service = `soundcloud-harvest`): an artist is only marked processed
once its staged links/bio are written successfully, or on a
definitive dead link (404) from the resolve call.

```bash
node scripts/harvest-soundcloud-links-and-bio.mjs
node scripts/harvest-soundcloud-links-and-bio.mjs --approved   # directory artists only
node scripts/harvest-soundcloud-links-and-bio.mjs --force      # re-process even artists with existing state
```

`--approved` restricts the run to directory artists (`directory_status = 'approved'`, excluding deleted).

### 2c. Direct-link harvesters

#### `harvest-links-discogs.mjs`
For each artist with a Discogs link, calls the official Discogs API
(`GET /artists/{id}`) and stages every usable URL from the response's
`urls` array into `artist_harvested_links` (source_platform =
`discogs`). Never writes to `artist_links` directly — 2d promotes.
Processed state is tracked in `resolved_artists` (service =
`discogs-links`), so re-runs only touch artists whose Discogs link
arrived since the last run. Throttled to ~55 req/min (Discogs allows
60/min authenticated).

```bash
npm run harvest-links-discogs
npm run harvest-links-discogs -- --approved    # directory artists only
npm run harvest-links-discogs -- --limit=20    # test run
npm run harvest-links-discogs -- --force       # re-process all
DRY_RUN=1 npm run harvest-links-discogs        # no writes
```

`--approved` restricts the run to directory artists (`directory_status = 'approved'`, excluding deleted).

Requires `DISCOGS_TOKEN` in `.env.local` (discogs.com → Settings →
Developers → "Generate new token").

Still planned: `harvest-links-linktree.mjs` and
`harvest-links-bandcamp.mjs` — see "Planned changes".

#### `harvest-links-loop.mjs` — the 2c+2d convergence loop
Runs all 2c harvesters then 2d in rounds until a round produces no
new staged or live links (links beget links: a Discogs page may
reveal a Linktree, a Linktree a Bandcamp). Convergence is detected
by row counts of `artist_harvested_links` and `artist_links` before
vs. after each round; because harvesters track state in the DB,
each round only touches artists with new links. This loop is the
skeleton for the eventual `orchestrate.mjs`.

```bash
npm run harvest-links-loop
npm run harvest-links-loop -- --approved       # directory artists only
npm run harvest-links-loop -- --max-rounds=2
DRY_RUN=1 npm run harvest-links-loop           # single round, no writes
```

`--approved` restricts the loop to directory artists (`directory_status = 'approved'`, excluding deleted); it is forwarded to every child stage (the 2c harvesters and 2d).

### 2d. `integrate-harvested-links.mjs`
Promotes rows from the `artist_harvested_links` staging table into
the live `artist_links` table. One surviving link per
(artist, platform) pair is inserted if no link exists yet; if one
already exists, the script flags any discrepancy for review but
does not overwrite.

Staged rows whose `parsed_platform` isn't a key in the `platforms`
table are skipped (left in staging, reported in the run summary)
until the key is added via the admin settings page — then a re-run
promotes them. All platforms the current harvesters emit, including
`youtube`, `facebook`, and `tiktok` (keys added 2026-07-03), are
valid.

```bash
node scripts/integrate-harvested-links.mjs
node scripts/integrate-harvested-links.mjs --approved   # directory artists only
```

`--approved` restricts promotion/flagging to directory artists (`directory_status = 'approved'`, excluding deleted).

### 2e. `fix-http-https-mismatches.mjs`
One-off cleanup (safe to re-run): rewrites `http://` links to
`https://` in `artist_harvested_links` and `artist_links`, and
clears any false mismatch flags caused by scheme differences alone.

```bash
node scripts/fix-http-https-mismatches.mjs
```

---

## Phase 3 — External matching (fallback)

The **fallback** for Last.fm, MusicBrainz, and Spotify links that
Phase 2's direct harvesting didn't find on artists' own pages: a
direct link is ground truth, a best match is an inference with a
confidence score. Runs directly after Phase 2 so all the
link-finding steps sit together in the process; its inputs are
only artist names, locations (`artist_locations`), and raw bios
(`artist_enrichment`, from 2a). Its links are then available to
the image and later phases. (It was formerly Phase 6, after
images; moved up and reframed as fallback 2026-07-03.)

Note: today the resolver only skips searching a service when the
artist already has a *Spotify* link; extending that skip to
Last.fm and MusicBrainz (so direct links found in Phase 2 suppress
the search entirely) is in "Planned changes".

### `resolve-and-load-links-lf-mb-sp.mjs`
Searches Last.fm, MusicBrainz, and Spotify for each directory
artist by name, scores and ranks candidates by name similarity,
location, and bio overlap, and upserts the best matches into
`artist_links`. Candidates below the confidence threshold
(`0.95`) are staged in `pending_artist_links` for manual review.

```bash
npm run resolve-and-load-links
```

State tracking: the resolver decides an (artist, service) pair is
already done by checking for existing `pending_artist_links` rows.
The orphaned `resolved_artists` table `(artist_id, service,
resolved_at)` — created in the dashboard, referenced by no code —
was evidently intended as an explicit tracker for exactly this.
Adopting it would make incremental re-runs cleaner than the current
inference (and fits the project preference for DB-tracked state
over cache files).

Full documentation of this script — flags, scoring, statuses, and
caveats — is in `MATCHING.md`. Note that no current-stack tool
processes the staged `close match` / `tie` / `pending` rows; the
legacy Python scripts (`review_candidates.py` export/import +
`load_links.py`) are still schema-compatible and remain the only
review workflow. See `MATCHING.md` for the comparison of the two
pipelines.

---

## Phase 4 — Bio processing

Must run after Phase 2 so bios are present in `artist_enrichment`.
No other phase depends on sanitized bios (Phase 3's matcher reads
the *raw* bios from 2a), so this can run any time before the site
displays them; it sits here to keep Phases 2–3, the link-finding
steps, adjacent.

### 4a. `sanitize-bios.mjs`
Runs every raw bio through DOMPurify: strips unsafe tags and
attributes, converts bare newlines to `<br>` for plain-text bios,
adds `rel="noopener noreferrer"` to all links. Writes to
`bio_sanitized` in `artist_enrichment`. Skips rows that already
have `bio_sanitized` set (use `--force` to re-sanitize).

```bash
npm run sanitize-bios
```

### 4b. `linkify-bios.ts`
Post-processes `bio_sanitized` to wrap bare URLs in `<a>` tags and
convert `@mentions` to SoundCloud profile links. Idempotent —
already-linked text is skipped.

```bash
npm run linkify-bios
```

---

## Phase 5 — Profile images

Runs after Phase 3 so image enrichment can draw on the full link
set, including the Last.fm, Spotify, and Wikipedia links Phase 3
resolves (all of which are in the platform priority list below).

### 5a. `enrich-images.ts`
For each approved artist without a `profile_image_url`, tries their
linked profiles in priority order (SoundCloud → Bandcamp → Resident
Advisor → …) and pulls the `og:image` meta tag as a best-effort
profile photo. No API key required. Supports `--limit=N`, `--force`,
`--platforms=a,b`, and `DRY_RUN=1`.

The single-artist core lives in `src/lib/enrich-images.ts` and is
also called automatically by the website — on admin quick-approve
(`src/app/admin/actions.ts`) and when image-capable links are added
on the artist edit page — so newly approved artists get an image
without waiting for a bulk run.

Caveat: URL fetch results are cached in `image-fetch-cache.json`
next to the script; use `--force` to bypass.

```bash
npm run enrich-images
```

### 5b. `store-images.mjs`
Re-hosts profile images: for each approved artist whose SoundCloud
enrichment has a `profile_image_url`, downloads the 500×500 variant
and uploads it to Supabase Storage (`artist-images/{artist_id}.jpg`),
then points `artists.profile_image_url` at the Storage URL. Skips
artists already on Storage URLs unless `--force`. Supports
`--limit=N` and `DRY_RUN=1`. Run after Phase 2 (needs SoundCloud
enrichment rows) and after 5a.

Note: SoundCloud-only for now — images 5a fetched from other
platforms stay hot-linked, and 5b can overwrite 5a's non-SoundCloud
choice. Generalizing it to all sources is in "Planned changes".

```bash
node scripts/store-images.mjs
```

---

## Phase 6 — Discography enrichment

### `enrich-bandcamp.mjs`
Fetches Bandcamp album and release data for artists that have a
Bandcamp link, scraping the music grid on each artist's page.
Writes to `artist_bandcamp_albums` (the numeric IDs feed Bandcamp's
embedded player). Benefits from Phases 2 and 3 running first: more
Bandcamp links found → more discographies fetched. (The same page
fetch could also capture sidebar links for 2c — see "Planned
changes".)

Always directory-only: it processes only artists with
`directory_status = 'approved'` (excluding deleted), so there is no
`--approved` flag — the orchestrator forwards one anyway, a harmless
no-op here.

```bash
npm run enrich-bandcamp
```

---

## Phase 7 — Recommendation engine signals

These scripts populate the signal tables used by the recommendation
engine. Run after Phase 3 so MusicBrainz IDs are available.

### 7a. `build-soundcloud-follow-graph.mjs`
For each approved directory artist with a SoundCloud link, fetches
their followings and writes directed edges to `sc_follow_edges`.
Also adds new artists discovered via followings to the `artists`
table with `directory_status = 'sc_followee'`.

```bash
npm run build-soundcloud-follow-graph
```

### 7b. `enrich-musicbrainz.mjs`
For each artist with a resolved MusicBrainz ID (written by Phase 3),
fetches their folksonomy tags and artist relationships. Tags go into
`mb_tags`; collaboration/membership edges where both artists are in
the database go into `mb_collaborations`.

```bash
npm run enrich-musicbrainz
```

### 7c. `fetch-lastfm-similar.mjs`
For each directory artist with a Last.fm link (written by Phase 3),
calls `artist.getSimilar` and stores the results in
`lastfm_similar_artists`. Where a similar artist can be matched to
an existing row in the `artists` table (via Last.fm URL, MusicBrainz
ID, or name), `similar_artist_id` is populated — this is what makes
the data useful for weight tuning. Used as the validation / ground
truth dataset for the scoring step; not a live production signal.

After adding new Last.fm links (e.g. manually resolving ties in
`pending_artist_links`), run with `--resolve-only` to backfill
`similar_artist_id` for existing rows without making any API calls.

```bash
npm run fetch-lastfm-similar
npm run fetch-lastfm-similar -- --resolve-only
```

### 7d. `harvest-genres-mb.mjs`
Copies rows from `mb_tags` (populated by `enrich-musicbrainz.mjs` in
Phase 7b) into the `artist_harvested_genres` staging table with
`source_platform = 'musicbrainz'`. No API calls — purely a
database-to-database copy. Must run after 7b.

```bash
npm run harvest-genres-mb
```

### 7e. `harvest-genres-lastfm.mjs`
For each artist with a Last.fm link, calls `artist.getTopTags` and
writes the results into `artist_harvested_genres` with
`source_platform = 'lastfm'`. Stores the Last.fm weighting (0–100)
as `tag_count`. Results are cached to `.cache/lastfm_genres/`.
Must run after Phase 3 so Last.fm links are in `artist_links`.

```bash
npm run harvest-genres-lastfm
```

Requires `LASTFM_API_KEY` in `.env.local`.

### 7f. `harvest-genres-spotify.mjs`
For each artist with a Spotify link, calls `GET /artists/{id}` and
writes the returned genre array into `artist_harvested_genres` with
`source_platform = 'spotify'`. Spotify does not provide a per-genre
weight, so `tag_count` is null for these rows. Results are cached to
`.cache/spotify_genres/`. Must run after Phase 3.

```bash
npm run harvest-genres-spotify
```

Requires `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env.local`.

### 7g. `integrate-harvested-genres.mjs`
Promotes rows from `artist_harvested_genres` into the live `genres`
and `artist_genres` tables. For each unprocessed row:

- Looks up the raw tag in `GENRE_ALIASES` to resolve variant
  spellings (e.g. "drum and bass", "d&b", "dnb" → "drum & bass").
- Checks against `BROAD_TAGS` and marks overly vague tags as skipped
  (e.g. "electronic", "edm", "seen live") without creating genre entries.
- Finds or creates the canonical genre in the `genres` table, then
  inserts the `artist_genres` link.
- Sets `genre_id` on the harvested row to mark it as processed.

Both `GENRE_ALIASES` and `BROAD_TAGS` are constants near the top of
the script — edit them freely to tune which tags survive and what
canonical names they map to. Run `--force-skipped` after updating
`BROAD_TAGS` to re-process rows that were previously discarded.

Must run after 7d, 7e, and 7f.

```bash
DRY_RUN=1 npm run integrate-harvested-genres -- --debug --limit=50   # verify first
npm run integrate-harvested-genres
npm run integrate-harvested-genres -- --force-skipped   # after editing BROAD_TAGS
```

---

## Phase 8 — Review / data quality

These scripts are run as-needed rather than on every pipeline run.

### `find-duplicates.mjs`
Read-only scan that scores potential duplicate artists based on
cross-platform handle similarity, shared contact emails, and name
fuzzy-matching. Outputs a CSV for manual review. Does not write to
the database.

```bash
npm run find-duplicates -- --output=duplicates.csv
```

### `qc-links.mjs`
Read-only validation of every row in `artist_links`. Detects
wrong-field entries (a URL stored under the wrong platform, e.g. a
musicbrainz.org URL in the lastfm field — and reports where it
should have gone) and format issues (whitespace, multiple URLs in
one field, unparseable URLs, plain `http://`, missing protocol).
Makes no changes; fix findings via the admin edit page. Useful
after any link-writing phase (2, 3).

```bash
node scripts/qc-links.mjs                     # check all rows
node scripts/qc-links.mjs --platform=lastfm   # one platform
node scripts/qc-links.mjs --name="Danz"       # artists matching name
node scripts/qc-links.mjs --limit=100         # first N artists
node scripts/qc-links.mjs --csv               # output issues as CSV
```

---

## Legacy scripts

The following scripts have been superseded and should not be included
in the automated pipeline:

- **`enrich-bios.mjs`** — early SoundCloud bio scraper that parsed
  SoundCloud's page HTML. Replaced by `enrich-soundcloud.mjs`, which
  uses the official API and is more reliable.

- **`apply-review-csv.mjs`** — applies manual review decisions from
  a CSV file (setting `directory_status`, deleting duplicates, etc.).
  Manual CSV-based review is no longer the intended workflow.

- **`clean-linktree-bios.mjs`** — one-time backfill that extracted
  Linktree URLs embedded in bios and moved them to
  `artists.linktree_url`. `enrich-soundcloud.mjs` (Phase 2a) now
  handles Linktree extraction as part of its bio processing, so new
  bios never need this pass. Safe to re-run, but no longer part of
  the pipeline.

- **Python candidate pipeline** (`resolve_candidates.py`,
  `review_candidates.py`, `load_links.py`, `recommend.py`, and the
  `recommender/` package) — the earlier standalone implementation of
  Phase 3 (external platform matching) plus a superseded
  recommendation engine. The Node script
  above was ported from it. Partially still useful: its review loop
  is the only tool for the staged-candidate backlog. Fully documented
  and compared against the current pipeline in `MATCHING.md`.

- **`compute-scores.mjs`** — Node version of the scoring step,
  superseded by the Python scoring pipeline (see `SCORING.md`).

---

## Utility / diagnostic scripts

Not part of the pipeline; run manually when debugging.

- **`test-connection.mjs`** — checks `.env.local` values and tries a
  raw fetch plus a supabase-js query against `artists`, printing
  everything. First stop when DB access misbehaves.
- **`test-queries.mjs`** — runs the directory's genre/country filter
  queries using the publishable key (exactly as the app does) to
  debug RLS or filter issues.
- **`commit-search-miss.sh`** (project root) — one-off git helper
  that committed the search-miss feature; safe to delete.
- **`test-xlsx.mjs`** (project root) — throwaway probe of the
  original spreadsheet's Beatport column; safe to delete.

- **`backfill-resolved-soundcloud-enrich.mjs`** — one-off migration
  helper, written 2026-07-03 when 2a switched from
  `enrich-soundcloud-cache.json` to `resolved_artists` (service =
  `soundcloud-enrich`) for processed-state tracking. Without it, the
  next 2a run would have treated every artist enriched before the
  switch as unprocessed and re-fetched them all from SoundCloud.

  Reads `artist_enrichment` for rows where `platform = 'soundcloud'`
  and `external_id` is not null — `external_id` (the SoundCloud
  numeric user ID) is set on every row `enrich-soundcloud.mjs`
  successfully upserts, so its presence is a cheap, reliable stand-in
  for "this artist was already enriched." For each matching
  `artist_id` not already in `resolved_artists` for this service, it
  upserts `{ artist_id, service: 'soundcloud-enrich', resolved_at }`
  — `resolved_at` is stamped with the time the script runs (one
  timestamp for the whole batch), since the original per-artist
  enrichment time lives only in `artist_enrichment.last_synced_at`,
  which this script doesn't need to read.

  Both reads (`artist_enrichment` and `resolved_artists`) use keyset
  pagination — `WHERE artist_id > cursor ORDER BY artist_id LIMIT n`
  — instead of `OFFSET`-based paging. This matters in practice: the
  first version used `.range()` (OFFSET) and hit a Postgres statement
  timeout even on a single 1000-row page, because an OFFSET page over
  a filtered condition still has to walk (and often sort) everything
  before it. Keyset pagination lets Postgres seek straight to the
  cursor and stop as soon as it has enough matches, so `--limit`
  directly buys smaller, cheaper round-trips rather than just a
  smaller final result.

  Requires the `resolved_artists` grants fix
  (`supabase_migration_resolved_artists_grants.sql`) to be applied
  first — `service_role` had no SELECT/INSERT/UPDATE/DELETE on that
  table until then, so both the read and the write fail with
  "permission denied for table resolved_artists" otherwise.

  Idempotent and safe to re-run (skips already-marked artist_ids);
  safe to delete once the backfill is confirmed complete.

  ```bash
  DRY_RUN=1 node scripts/backfill-resolved-soundcloud-enrich.mjs            # preview, no writes
  node scripts/backfill-resolved-soundcloud-enrich.mjs
  node scripts/backfill-resolved-soundcloud-enrich.mjs --limit=200          # smaller batches per round-trip, if the full run times out
  node scripts/backfill-resolved-soundcloud-enrich.mjs --after=<artist_id>  # resume after this artist_id (printed on a --limit run)
  ```

  No equivalent backfill was written for 2b
  (`harvest-soundcloud-links-and-bio.mjs`, service =
  `soundcloud-harvest`) — a fresh run will just re-harvest artists
  that already have `artist_harvested_links`/`artist_harvested_bios`
  rows from before the switch, which is wasted API calls but harmless
  (upserts on `artist_id,parsed_url`).

---

## Shared libraries (`scripts/lib/`)

- **`name-utils.mjs`** — strips invisible Unicode/whitespace from
  artist names; provides `isBlankArtistName()`. Used by
  `clean-artist-names.mjs` and the Phase 3 resolver.
- **`linktree.mjs`** — finds/removes Linktree URLs in bio text. Used
  by `enrich-bios.mjs` and `clean-linktree-bios.mjs`.
- **`soundcloud-bio.mjs`** — SoundCloud bio parsing shared by
  `enrich-bios.mjs` (legacy) and `enrich-soundcloud.mjs`.
- **`scoring.py`** — signal loading, Supabase client, pair
  enumeration, and Jaccard scoring for the Python scoring pipeline
  (see `SCORING.md`).

---

## Ongoing entry point — website submissions, revisions, and edits

The bulk CSV load (Phase 0) ran once; since then, artists enter and
change through the website. This flow is handled by the Next.js app,
not pipeline scripts, but it feeds the same tables the pipeline
enriches — an approved submission is, in effect, a new Phase 0 row
for one artist.

### New artist submission

```
/submit form → POST /api/submit
  ├─ artists                (directory_status = 'unverified';
  │                          'pending' if the email is already verified)
  ├─ artist_labels          (labels from the form)
  ├─ pronouns               (new values created on demand; artists.pronoun_id)
  ├─ artist_locations       (city/country from the form)
  ├─ artist_links           (platform links from the form)
  ├─ submitter_emails       (reputation upsert: submission_count++)
  └─ verification_tokens    (target_type 'artist') → verification email

email link → /api/verify
  ├─ artists                'unverified' → 'pending'  (into review queue)
  └─ submitter_emails       'unverified' → 'verified'

admin panel → quickApprove (src/app/admin/actions.ts)
  ├─ artists                directory_status = 'approved'
  └─ auto-runs single-artist image enrichment in the background
     (src/lib/enrich-images.ts — the Phase 5a core)
     [alternatives: 'rejected', 'not_eligible']
```

**The enrichment gap:** after approval an artist has only their
form data and (maybe) a profile image. SoundCloud enrichment
(Phase 2), external links (3), bio processing (4), image
re-hosting (5b), genres (7), and similarity scores (`SCORING.md`) all
wait for the next manual bulk run. Per-artist versions of these
phases, triggered on approval, are the natural next orchestration
step — `quickApprove`'s image enrichment is the template.

### Edit suggestion from the public

```
/artist/[id]/revise → POST /api/revise
  ├─ artist_revisions       (status 'unverified', proposed changes
  │                          as a revision_data jsonb blob)
  ├─ submitter_emails       (reputation upsert)
  └─ verification_tokens    (target_type 'revision') → email

email link → /api/verify    revision 'unverified' → 'pending'

admin panel → approve/reject
  └─ approved: revision_data applied to artists / artist_links /
     artist_labels / etc.
```

An approved revision that adds or changes platform links logically
re-enters the pipeline the same way a new artist does (the changed
links affect Phases 2, 3, 5, 6, and 7 for that artist).

### Direct edit (admin / owner)

`/artist/[id]/edit` writes `artist_aliases` and `artist_labels`
wholesale (delete + insert), plus links and core fields, and
auto-runs image enrichment when new image-capable links are added.
`artist_aliases` (alternate names) exists only in this flow — no
pipeline script or submit form touches it.

### Reference and reputation tables

- **`platforms`**, **`pronouns`** — lookups; see Phase 0.
- **`submitter_emails`** — per-email reputation
  (`unverified`/`verified`/`blocked`, submission count, block
  reason). Written by `src/lib/submission-helpers.ts`, `/api/verify`,
  and admin actions; managed in admin settings. Verified emails skip
  the verification step on later submissions.
- **`verification_tokens`** — single-use tokens backing both flows
  above (`target_type` = `artist` | `revision`, expiry, `used_at`).
  Issued by `src/lib/submission-helpers.ts` / `src/lib/email.ts`,
  consumed by `/api/verify`.

### Loose ends

- **`artist_harvested_bios`** — Phase 2b stages raw SoundCloud bios
  here, mirroring how 2b stages links in `artist_harvested_links`,
  but a bio analogue of the 2d "integrate" step was never built —
  bios reach `artist_enrichment` via Phase 2a instead. Wire it up
  or drop it.
- **`resolved_artists`** — orphaned resolver state table; see the
  note under Phase 3.

---

## Typical full run order

```bash
npm run clean-artist-names
npm run enrich-soundcloud
node scripts/harvest-soundcloud-links-and-bio.mjs
node scripts/integrate-harvested-links.mjs
node scripts/fix-http-https-mismatches.mjs
npm run resolve-and-load-links
npm run sanitize-bios
npm run linkify-bios
npm run enrich-images
node scripts/store-images.mjs
npm run enrich-bandcamp
npm run build-soundcloud-follow-graph
npm run enrich-musicbrainz
npm run fetch-lastfm-similar
npm run harvest-genres-mb
npm run harvest-genres-lastfm
npm run harvest-genres-spotify
npm run integrate-harvested-genres
```

---

## Planned changes

Agreed optimizations and cleanups, not yet implemented:

### Merge the two SoundCloud scripts into one "SoundCloud sync" stage

`enrich-soundcloud.mjs` (2a) and `harvest-soundcloud-links-and-bio.mjs`
(2b) each call `GET /resolve?url=<profile-url>` for the same artists —
the same call returning the same user resource. Merging them into a
single stage would:

- **Cut API calls from 3 to 2 per artist.** One `/resolve` (profile
  data + bio + urn) followed by one `/users/{urn}/web-profiles`
  (links). Two is the floor — SoundCloud has no endpoint that returns
  the user resource and web-profiles together. (The conditional
  `/users/{id}/playlists` call for zero-track artists is unaffected.)
- **Unify the bio path.** Today 2a writes bios to
  `artist_enrichment.bio` (the live path) while 2b stages them in
  `artist_harvested_bios`, which nothing consumes. The merged stage
  writes bios one way; decide then whether `artist_harvested_bios`
  is wired up as a raw-bio audit trail or dropped.
- **Give orchestration a single per-artist-callable unit.** One
  "sync this artist from SoundCloud" function fits the
  event-triggered flow (run on approval) as well as the bulk run.

### Skip `/resolve` on re-runs using the stored user ID

`enrich-soundcloud.mjs` already stores each artist's numeric
SoundCloud user ID in `artist_enrichment`. Re-runs (or a links-only
refresh) can call `/users/{urn}/web-profiles` and `/users/{id}`
directly from the stored ID instead of re-resolving the profile URL:
1 call per artist for a links refresh, and immune to resolve
failures when an artist renames their profile URL.

### Generalize `store-images.mjs` (5b) to all image sources

5b currently re-hosts only SoundCloud images: it sources from
`artists.sc_image_url` / the `soundcloud` row of `artist_enrichment`,
applies a SoundCloud-CDN-specific `-t500x500` resize rewrite, and
hardcodes `profile_image_source = 'soundcloud'`. Images that 5a
fetched from other platforms (Bandcamp, Resident Advisor, Discogs, …)
stay hot-linked to the source site — vulnerable to URL rot, and every
source domain must be allowlisted in `next.config` for `next/image`.

There is also an override bug: 5b's "already stored" check only
skips Storage URLs, so an artist whose image 5a chose from Bandcamp
gets silently overwritten with the re-hosted SoundCloud image if one
exists.

Plan: re-host `artists.profile_image_url` from *any* source — apply
the resize rewrite only to SoundCloud CDN URLs (other sources are
fetched at whatever size the og:image provides), record the true
`profile_image_source` instead of hardcoding `'soundcloud'`, and
keep the existing Storage upload path. Once every image is served
from our own Storage domain, the per-source allowlist in
`next.config` can be reduced to just that domain.

### Build out Phase 2c: the direct-link harvesters

The pipeline doc now places all direct link gathering in Phase 2
(before best-match inference in Phase 3); these are the scripts
that implement it:

```
Phase 2c:
  harvest-links-discogs.mjs     ✅ BUILT (2026-07-03) — see Phase 2c
  harvest-links-linktree.mjs    see below
  harvest-links-bandcamp.mjs    Bandcamp artist pages carry a sidebar
                                of external links on the same page
                                enrich-bandcamp.mjs (Phase 6) already
                                fetches for the music grid; capture
                                them (shared fetch or separate pass)

After Phase 3 (needs resolved MusicBrainz IDs):
  MB URL-rels                   move the url-rel harvesting inside
                                enrich-musicbrainz.mjs (7b) to write to
                                artist_harvested_links staging instead
                                of directly to artist_links, then
                                promote via 2d
  harvest-links-wikidata.mjs    possible — MB url-rels often include a
                                Wikidata item, whose structured claims
                                (official site, Instagram, Discogs /
                                SoundCloud / Bandcamp IDs) have a real
                                API; currently wikidata.org is in
                                enrich-musicbrainz's SKIP_DOMAINS
```

All new harvesters write to the `artist_harvested_links` staging
table — never directly to `artist_links` — so 2d's promotion and
conflict-flagging applies uniformly. Run 2c + 2d in a loop until no
new links appear (links beget links).

**The 2c + 2d convergence loop is BUILT (2026-07-03):
`harvest-links-loop.mjs`** — see Phase 2c. It is the orchestrator
in miniature: stage scripts run as child processes, per-artist
processed state in the database (`resolved_artists` is now adopted —
service `discogs-links`), convergence detected by before/after row
counts, loop stops when a round produces nothing new. The full
`orchestrate.mjs` grows from this skeleton: each later phase becomes
another stage plugged into the same pattern. Future harvesters just
get added to the `HARVESTERS` array in the loop script.

### Skip best-match search when a direct link exists

`resolve-and-load-links-lf-mb-sp.mjs` currently skips searching
only Spotify when the artist already has a Spotify link; Last.fm
and MusicBrainz are searched regardless (the load step won't
overwrite, but the API calls and staged candidates are wasted, and
a wrong best-match candidate can sit in `pending_artist_links`
next to a correct direct link). Extend the existing Spotify-style
skip to all three services, so Phase 2's direct links suppress
Phase 3 work entirely for those (artist, service) pairs.

Considered and set aside: Spotify (API exposes no external links),
Last.fm (none structured; page links mostly mirror MB's), Resident
Advisor (links exist on ra.co artist pages but only via an
unofficial GraphQL endpoint — fragile; revisit later), Beatport /
Qobuz / Tidal / Apple Music pages (no meaningful outbound links).

### New harvester: `harvest-links-discogs.mjs` ✅ BUILT (2026-07-03)

The link harvesting described below is implemented (see Phase 2c).
Not yet implemented from this entry: using `namevariations` /
`aliases` to populate `artist_aliases`, `profile` text as a bio
fallback, and `members`/`groups` as a collaboration signal — those
remain future enhancements.

Discogs is currently only a link *destination* (CSV slugs via
`migrate.mjs`, SoundCloud web-profiles via 2b, MusicBrainz url-rels
via 7b) — nothing reads *from* it, even though it has an official,
free REST API. `GET https://api.discogs.com/artists/{id}` returns:

- a `urls` array of external links — often extensive for electronic
  artists (Bandcamp, SoundCloud, RA, socials, personal sites);
- `namevariations` and `aliases` — could populate `artist_aliases`,
  which today is only written by manual edits;
- `profile` text — a bio fallback for artists with no SoundCloud bio;
- `members` / `groups` — a potential collaboration signal.

Plan: extract the artist ID from stored `discogs.com/artist/{id}`
URLs in `artist_links`, fetch each artist, and write links to the
`artist_harvested_links` staging table so `integrate-harvested-links.mjs`
(2d) handles promotion and conflict-flagging exactly as it does for
SoundCloud finds. Rate limit is 60 req/min with a free personal
token — the full directory in ~25 minutes. Before building, run
`node scripts/qc-links.mjs --platform=discogs` to gauge how many
stored Discogs links are valid (the CSV-derived ones were
best-effort).

### New harvester: `harvest-links-linktree.mjs`

`artists.linktree_url` is already populated (extracted from
SoundCloud bios by 2a), and Linktree pages exist precisely to list
an artist's other platforms. Harvesting the links from each artist's
Linktree page and staging them in `artist_harvested_links` (same
promotion path as above) would recover much of what Instagram bios
contain — without scraping Instagram, which was considered and
rejected: Meta's ToS prohibits automated collection, logged-out
requests hit login walls, the official APIs expose no third-party
profile data, and any scraper would break constantly. Pronouns
should instead come from the site's own submit/revise forms, and
follower counts already come from SoundCloud and Spotify.

### Related cleanups to fold in

- Adopt `resolved_artists` (or equivalent DB-tracked state) instead
  of cache-file / inference-based "already processed" checks — see
  the Phase 3 note and the project preference for DB state.
  **2a (`soundcloud-enrich`) and 2b (`soundcloud-harvest`) are now
  done (2026-07-03)** — both dropped their `*-cache.json` files for
  `resolved_artists` rows, matching the 2d convention. Artists
  enriched before the switch were backfilled via the one-off
  `backfill-resolved-soundcloud-enrich.mjs` — see "Utility /
  diagnostic scripts" below for how it works; no equivalent backfill
  was written for 2b.

  **Found while running that backfill (2026-07-03): `resolved_artists`
  was missing basic table grants** — `service_role` had no
  SELECT/INSERT/UPDATE/DELETE on it, only REFERENCES/TRIGGER/TRUNCATE/
  MAINTAIN, so *every* script touching it (2a, 2b, `harvest-links-discogs.mjs`,
  `harvest-links-loop.mjs`, the backfill script) failed with
  "permission denied for table resolved_artists" — meaning the 2d
  Discogs harvester likely never successfully recorded state in
  production. Fixed by `supabase_migration_resolved_artists_grants.sql`
  (run in the Supabase SQL editor) — grants `service_role` full CRUD,
  matching every other service_role-only table (e.g.
  `artist_enrichment`).

  **The Phase 3 resolver (`resolve-and-load-links-lf-mb-sp.mjs`) is now
  done (2026-07-05)** — its processed state was already derived from
  `pending_artist_links` (via `alreadyResolved()`), and its `.cache/`
  disk-JSON response cache was moved into the `api_response_cache` table
  (`supabase_migration_api_response_cache.sql`; see MATCHING.md → "Response
  cache (DB-backed)").

  Still open: the genre harvesters' `.cache/` directories.
- Replace the `.cache/` disk caches used by the genre harvesters with
  DB-tracked state.
