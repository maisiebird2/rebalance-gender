# Genres

How genres are ingested, normalised, cleaned up, and displayed.

A genre travels through four stages:

```
harvest ──▶ integrate / normalise ──▶ live tables ──▶ cleanup ──▶ display
 (raw tags)   (canonical names)        (genres +       (dedupe,    (filter,
                                        artist_genres)   prune,      ≥3 rule)
                                                         status)
```

Everything about the *vocabulary* — how a raw tag becomes a canonical
genre name — lives in one file, `scripts/integrate-harvested-genres.mjs`,
and is exported so every other tool shares the exact same rules.

---

## Data model

Three tables (inspect the live schema via read-only psql — see `.env.local` `SUPABASE_DB_URL`):

| Table | Purpose |
|---|---|
| `genres` | The canonical list. `id`, `name` (unique), `status` (`pending` / `approved` / `deleted`). |
| `artist_genres` | Junction: `(artist_id, genre_id)` — which artists have which genres. PK forbids duplicate links. |
| `artist_harvested_genres` | Raw tags as scraped from each source (`raw_tag`, `source_platform`), with a nullable `genre_id` once resolved. Staging area for integration. |

`status = 'deleted'` **hides** a genre; it does not remove the row or its
artist links, so it is fully reversible. Deleting a `genres` row instead
cascades and removes its `artist_genres` links.

---

## The vocabulary (single source of truth)

`scripts/integrate-harvested-genres.mjs` defines and **exports** the
normalisation logic. Other scripts import it rather than re-implementing:

- `normaliseTag(rawTag)` → `{ canonical, skip }`. The one function that
  turns any raw tag or genre name into its canonical form. Order:
  1. lowercase + trim, apply `WORD_FIXES` (spelling fixes like
     `avantgarde` → `avant-garde`);
  2. `collapseSpacedLetters` — collapse stylised single-letter spacing
     (`t e c h n o` → `techno`, `e-l-e-c-t-r-o` → `electro`). Only fires
     on 3+ tokens that are *all* single characters, so real multi-word
     genres (`drum & bass`, `2-step garage`, `a cappella`) are untouched;
  3. `BROAD_TAGS` check → if matched, `skip: true` (tag is too vague to
     be a genre, e.g. "seen live"); it is dropped, not stored;
  4. `GENRE_ALIASES` lookup (exact, then accent/hyphen-normalised) →
     canonical display name;
  5. otherwise store the accent-stripped lowercase tag as-is.
- `GENRE_ALIASES` — a `Map` of alternate spelling → canonical name
  (e.g. `rnb`, `rhythm & blues` → `r&b`; the drum & bass family →
  `drum & bass`). **This is the file you edit** when you spot duplicate
  spellings. Keys are lowercase; values set the display casing.
- `BROAD_TAGS` — tags to discard entirely.
- `normalizeForLookup(str)` — accent/hyphen-insensitive key used for
  matching and grouping.

Because these are exported and `main()` is guarded, importing the file
does not run the pipeline.

---

## Ingestion

1. **Harvest** — `harvest-genres-lastfm.mjs`, `harvest-genres-mb.mjs`,
   `harvest-genres-spotify.mjs` scrape raw tags per artist into
   `artist_harvested_genres` (each row a `raw_tag` + `source_platform`).
2. **Integrate** — `integrate-harvested-genres.mjs` promotes unprocessed
   rows into the live tables. For each row it runs `normaliseTag`, then
   finds-or-creates the canonical genre, inserts the `artist_genres` link
   (`ON CONFLICT DO NOTHING`), and stamps the harvested row's `genre_id`
   so re-runs skip it. It ends with a `deduplicateGenres()` pass that
   merges genres whose *names* normalise to the same string.

```bash
node scripts/integrate-harvested-genres.mjs            # run
DRY_RUN=1 node scripts/integrate-harvested-genres.mjs  # preview
```

Note: the built-in dedup pass only catches accent/hyphen name collisions.
Duplicates that are only equal *through the alias map* (different
connectives, misspellings) are handled retroactively by the dedupe tool
below.

---

## Cleanup tooling

All of these run locally against Supabase (they need `.env.local`), and
all support `--dry-run`. Run the report first; it drives the rest.

### `genre-report.mjs` — the review sheet (read-only)

Writes `genre-report.csv`, one row per genre with: `artist_count`,
`harvested_count`, `alias_canonical` (set if the alias map would merge
this row), `is_broad_tag`, and `suspected_non_genre`. It also prints the
artist-count distribution (how many genres have ≤1, ≤2, ≤3 … artists).

`suspected_non_genre` combines two signals:
- **Heuristics** (`scripts/lib/non-genre-hints.mjs`) flag places
  (`london`, `berlin`), decades (`80s`), roles (`pianist`), and library
  junk (`funk_add_to_lidarr_batch_2`, `better than alok`). HINT-only.
- **Artist-name match** — flags any genre whose name exactly matches an
  artist in the `artists` table (`ariana grande`, `kaytranada`), the
  high-precision way to catch artist/label names used as genres.

```bash
node scripts/genre-report.mjs
```

`genre-report*.csv` is git-ignored (regenerated output).

### `dedupe-genres-by-alias.mjs` — merge duplicate rows

Groups existing `genres` rows by their alias-resolved canonical name
(via `normaliseTag`, so spaced-out and mis-spelled forms collapse too)
and merges each group into one: repoints `artist_genres` (deleting
would-be duplicate links) and `artist_harvested_genres`, renames the
survivor to the canonical spelling, deletes the losers.

```bash
node scripts/dedupe-genres-by-alias.mjs --dry-run
node scripts/dedupe-genres-by-alias.mjs --only="drum & bass"   # one group
node scripts/dedupe-genres-by-alias.mjs                        # all groups
```

### `prune-genres.mjs` — shrink the vocabulary

Two phases, run rollup *before* cut:
- **Rollup** — merge each subgenre in the editable `ROLLUP` map into its
  parent (so artists in a tiny subgenre keep a broader tag).
- **Cut** — genres under `--threshold` (default 3) get `status='deleted'`
  (reversible) or, with `--hard`, are deleted outright.

```bash
node scripts/prune-genres.mjs --dry-run --threshold=3
node scripts/prune-genres.mjs --rollup-only
node scripts/prune-genres.mjs --threshold=3
```

### `apply-genre-status.mjs` — CSV-driven status changes

Edit the `status` column in `genre-report.csv` (set rows to `deleted`,
keep `id` intact), then apply. Matches on `id`, verifies the CSV `name`
still matches the DB (skips stale rows), and updates only changed rows.

```bash
node scripts/apply-genre-status.mjs --dry-run
node scripts/apply-genre-status.mjs
node scripts/apply-genre-status.mjs --sql-out=genre-status.sql   # emit a migration
```

---

## Display rule (live, at read time)

The public genre filter is `getGenreOptions()` in `src/lib/queries.ts`.
A genre appears only if it has at least `MIN_APPROVED_ARTISTS_FOR_GENRE`
(= 3) **approved, non-deleted** artists — so genres with ≤2 approved
artists are hidden and reappear automatically once they grow. This is
computed live (no DB writes) and is independent of `genres.status`, so it
never conflicts with manual deletions.

The count is wrapped in `unstable_cache` (`revalidate: 600`s) so the heavy
per-genre aggregation runs at most once every 10 minutes, not on every
page load. Lower the window for fresher results, raise it to cut load.

Scope: this affects **only the browse filter**. The submit/edit genre
pickers still list all approved genres (so artists can be tagged with rare
ones), and artist-profile genre chips are unaffected.

The admin moderation list (`src/app/admin/settings/page.tsx`) paginates
with `.range()` so it shows *all* genres regardless of count (PostgREST
caps a single query at ~1000 rows).

---

## Recipes

**Deduplicate some spellings.** Add `spelling → canonical` entries to
`GENRE_ALIASES` in `integrate-harvested-genres.mjs`, then
`node scripts/dedupe-genres-by-alias.mjs --dry-run` → apply. This also
stops future harvests recreating them.

**Do a full cull toward ~N genres.** Run `genre-report.mjs`; read the
≤N-artists distribution to pick a cut threshold; fill `ROLLUP` in
`prune-genres.mjs` from the long tail; `--dry-run` → apply.

**Delete specific genres by hand.** Edit `status` → `deleted` in the CSV,
run `apply-genre-status.mjs`.

**Change the visibility cutoff.** Edit `MIN_APPROVED_ARTISTS_FOR_GENRE`
in `src/lib/queries.ts`.

---

## Safety notes

- Every write tool supports `--dry-run` / `DRY_RUN=1`; preview first.
- `status='deleted'` is reversible; hard-deleting rows (`--hard`, or
  `dedupe`'s loser deletion) is not.
- These scripts must run **locally** with `.env.local`; they cannot reach
  Supabase from the Cowork sandbox.
