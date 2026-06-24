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
Phase 2 │ SoundCloud enrichment
Phase 3 │ Bio processing
Phase 4 │ Profile images
Phase 5 │ Additional platforms (Bandcamp, Beatport)
Phase 6 │ External matching (Last.fm, MusicBrainz, Spotify)
Phase 7 │ Recommendation engine signals
Phase 8 │ Review / data quality
```

---

## Phase 0 — Initial load *(run once)*

### `migrate.mjs`
Loads the master CSV (`women, femmes, enbies of electronic music - list (genres normalized).csv`)
into the database: artists, genres, locations, and platform links.
Run once when setting up a fresh database. Refuses to run if
`artists` already has rows (to prevent duplicates).

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

## Phase 2 — SoundCloud enrichment

These three scripts work together to pull data from SoundCloud for
every directory artist that has a SoundCloud link.

### 2a. `enrich-soundcloud.mjs`
Uses the official SoundCloud API to fetch each artist's profile
data: bio, follower count, track count, profile image URL, and
numeric user ID. Writes to `artist_enrichment` (platform = `soundcloud`).

```bash
npm run enrich-soundcloud
```

Requires `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET` in `.env.local`.

### 2b. `harvest-soundcloud-links-and-bio.mjs`
Uses the official SoundCloud API (`/users/{urn}/web-profiles`) to
fetch each artist's platform links (Instagram, Spotify, Bandcamp,
etc.) from the "Links" section of their SoundCloud profile. Writes
to the `artist_harvested_links` staging table — does not touch
`artist_links` directly. Also fetches bios.

```bash
node scripts/harvest-soundcloud-links-and-bio.mjs
```

### 2c. `integrate-harvested-links.mjs`
Promotes rows from the `artist_harvested_links` staging table into
the live `artist_links` table. One surviving link per
(artist, platform) pair is inserted if no link exists yet; if one
already exists, the script flags any discrepancy for review but
does not overwrite.

```bash
node scripts/integrate-harvested-links.mjs
```

### 2d. `fix-http-https-mismatches.mjs`
One-off cleanup (safe to re-run): rewrites `http://` links to
`https://` in `artist_harvested_links` and `artist_links`, and
clears any false mismatch flags caused by scheme differences alone.

```bash
node scripts/fix-http-https-mismatches.mjs
```

---

## Phase 3 — Bio processing

Must run after Phase 2 so bios are present in `artist_enrichment`.

### 3a. `clean-linktree-bios.mjs`
Extracts any Linktree URLs embedded in bios and moves them to
`artists.linktree_url`. This was a one-time backfill; `enrich-soundcloud.mjs`
now handles Linktree extraction going forward. Safe to re-run.

```bash
node scripts/clean-linktree-bios.mjs
```

### 3b. `sanitize-bios.mjs`
Runs every raw bio through DOMPurify: strips unsafe tags and
attributes, converts bare newlines to `<br>` for plain-text bios,
adds `rel="noopener noreferrer"` to all links. Writes to
`bio_sanitized` in `artist_enrichment`. Skips rows that already
have `bio_sanitized` set (use `--force` to re-sanitize).

```bash
npm run sanitize-bios
```

### 3c. `linkify-bios.mjs`
Post-processes `bio_sanitized` to wrap bare URLs in `<a>` tags and
convert `@mentions` to SoundCloud profile links. Idempotent —
already-linked text is skipped.

```bash
npm run linkify-bios
```

---

## Phase 4 — Profile images

### `enrich-images.mjs`
For each artist without a `profile_image_url`, tries their linked
profiles in priority order (SoundCloud → Bandcamp → Resident
Advisor → Instagram → …) and pulls the `og:image` meta tag as a
best-effort profile photo. No API key required.

```bash
npm run enrich-images
```

---

## Phase 5 — Additional platforms

### `enrich-bandcamp.mjs`
Fetches Bandcamp album and release data for artists that have a
Bandcamp link. Writes to `artist_bandcamp_albums`.

```bash
npm run enrich-bandcamp
```

### `add-beatport-links.mjs`
Adds Beatport profile links for artists where a Beatport slug was
present in the original CSV but not yet written to `artist_links`.
Mostly a one-time task.

```bash
npm run add-beatport-links
```

---

## Phase 6 — External platform matching

### `resolve-and-load-links-lf-mb-sp.mjs`
Searches Last.fm, MusicBrainz, and Spotify for each directory
artist by name, scores and ranks candidates by name similarity,
location, and bio overlap, and upserts the best matches into
`artist_links`. Candidates below the confidence threshold
(`0.95`) are staged in `pending_artist_links` for manual review.

```bash
npm run resolve-and-load-links
```

---

## Phase 7 — Recommendation engine signals

These scripts populate the signal tables used by the recommendation
engine. Run after Phase 6 so MusicBrainz IDs are available.

### 7a. `build-soundcloud-follow-graph.mjs`
For each approved directory artist with a SoundCloud link, fetches
their followings and writes directed edges to `sc_follow_edges`.
Also adds new artists discovered via followings to the `artists`
table with `directory_status = 'sc_followee'`.

```bash
npm run build-soundcloud-follow-graph
```

### 7b. `enrich-musicbrainz.mjs`
For each artist with a resolved MusicBrainz ID (written by Phase 6),
fetches their folksonomy tags and artist relationships. Tags go into
`mb_tags`; collaboration/membership edges where both artists are in
the database go into `mb_collaborations`.

```bash
npm run enrich-musicbrainz
```

### 7c. `fetch-lastfm-similar.mjs`
For each directory artist with a Last.fm link (written by Phase 6),
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

---

## Typical full run order

```bash
npm run clean-artist-names
npm run enrich-soundcloud
node scripts/harvest-soundcloud-links-and-bio.mjs
node scripts/integrate-harvested-links.mjs
node scripts/fix-http-https-mismatches.mjs
node scripts/clean-linktree-bios.mjs
npm run sanitize-bios
npm run linkify-bios
npm run enrich-images
npm run enrich-bandcamp
npm run add-beatport-links
npm run resolve-and-load-links
npm run build-soundcloud-follow-graph
npm run enrich-musicbrainz
npm run fetch-lastfm-similar
```
