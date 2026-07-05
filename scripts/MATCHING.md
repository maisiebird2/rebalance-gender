# External Platform Matching — Two Pipelines

The repo contains **two implementations** of the same task: finding each
directory artist's profile on Last.fm, MusicBrainz, and Spotify, scoring
candidate matches, and writing the winners to `artist_links`.

| | Pipeline | Status |
|---|---|---|
| **A** | `resolve-and-load-links-lf-mb-sp.mjs` (Node) | **Current** — documented as Phase 3 in `PIPELINE.md` (formerly Phase 6; moved up 2026-07-03) |
| **B** | `resolve_candidates.py` → `review_candidates.py` / `load_links.py` + `recommender/` package (Python) | **Legacy** — imported 2026-06-22 (commit `19c8a7e`) from an earlier standalone project and not modified since |

How we know A is current: both landed in the same commit on 2026-06-22
("Loaded py scripts"), but only the Node script received follow-up fixes
(through 2026-06-23), is wired into `package.json`
(`npm run resolve-and-load-links`), and is referenced by `PIPELINE.md`
(as Phase 3, external platform matching) and `IMPROVEMENT_PLAN.md`. The Python scripts were the *source* the Node port
was made from — the scoring section of the `.mjs` says "Ported from
recommender/scoring.py".

**Positioning (as of 2026-07-03):** matching is the *fallback* for
links that direct harvesting (PIPELINE.md Phase 2) doesn't find on
artists' own pages — a direct link is ground truth; a best match is
an inference. The resolver should eventually skip any (artist,
service) pair that already has a direct link (see PIPELINE.md
"Planned changes").

**Important caveat:** the current pipeline auto-loads only `best match`
rows. Rows staged as `close match`, `tie`, or `pending` require manual
review — and the only tooling for that review lives in the legacy Python
pipeline (see "What the legacy pipeline has that the current one doesn't"
below).

---

## Shared concepts

Both pipelines use the same data model and scoring approach:

**Staging table** — `pending_artist_links`. Every scored candidate is
written here with per-signal scores, combined confidence, rank, raw
`api_data` JSON, and a status:

| Status | Meaning | Set by |
|---|---|---|
| `best match` | Single auto-selected winner | resolver |
| `close match` | Confidence ≥ 0.95 but not the winner | resolver |
| `tie` | Shares top confidence; tie-breaking failed (always ≥ 2 such rows) | resolver |
| `pending` | Everything else | resolver |
| `approved` / `rejected` / `skipped` | Human review decision | reviewer |
| `loaded` | Promoted into `artist_links` | loader |

**Scoring** — weighted average of up to four signals, renormalised when a
signal is unavailable:

| Signal | Weight | Method |
|---|---|---|
| name | 0.67 | token_set_ratio × F1 token-coverage (coverage penalises substring matches like "1111" vs "Quarteto 1111") |
| location | 0.20 | token overlap coefficient on city/region/country tokens |
| bio | 0.09 | asymmetric keyword overlap (our bio keywords found in candidate description) |
| popularity | 0.04 | plausibility check — very famous candidates (Spotify popularity > 80, Last.fm > 5M listeners) are penalised as likely mainstream mismatches |

**Tie-breaking** (when multiple candidates share top confidence):
exact case-insensitive name match → shortest candidate name → give up
(status `tie` for manual resolution).

**Candidate sources** — Last.fm `artist.search` (+ top tags), MusicBrainz
`/ws/2/artist` search (area/begin-area and disambiguation feed the
location/bio signals), Spotify `/v1/search` (genres, popularity,
followers). 5 candidates per service.

---

## Pipeline A (current) — `resolve-and-load-links-lf-mb-sp.mjs`

One script does the whole flow end to end:

1. Fetch all artists with locations (`artist_locations`) and bios
   (`artist_enrichment`).
2. For each (artist, service) pair not already resolved: search, score,
   classify (`best match` / `close match` / `tie` / `pending`).
3. Upsert candidates to `pending_artist_links`
   (conflict key `artist_id, service, external_id`).
4. Export a CSV snapshot of the entire staging table to
   `resolve-candidates-YYYY-MM-DD.csv` in the project root.
5. Load every `best match` row into `artist_links`
   (`{artist_id, platform, url}`) and mark it `loaded`.

```bash
npm run resolve-and-load-links                       # full run
node scripts/resolve-and-load-links-lf-mb-sp.mjs --artist "Bicep"   # one artist
node scripts/resolve-and-load-links-lf-mb-sp.mjs --limit 10         # random sample of N
node scripts/resolve-and-load-links-lf-mb-sp.mjs --service lastfm   # one service
node scripts/resolve-and-load-links-lf-mb-sp.mjs --force            # re-process resolved pairs
node scripts/resolve-and-load-links-lf-mb-sp.mjs --dry-run          # score + print, no writes
node scripts/resolve-and-load-links-lf-mb-sp.mjs --no-load          # stage only, skip step 5
```

Requires in `.env.local`: `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SECRET_KEY`, `LASTFM_API_KEY`, `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`. Talks to the DB via the Supabase JS client
(REST), not a direct Postgres connection.

Behaviour worth knowing:

- **Auto-load guard**: a winner is only labelled `best match` (and hence
  auto-loaded) if its confidence is ≥ 0.95 (`BEST_MATCH_THRESHOLD`).
  Lower-confidence winners stay `pending`.
- **Never overwrites**: the load step skips any (artist, platform) pair
  that already has a row in `artist_links` (e.g. manually added).
- **Skips**: artists that already have a Spotify link are not re-searched
  on Spotify; blank/invisible-character names are skipped
  (`lib/name-utils.mjs`).
- **`--limit` is a random sample**, not the first N alphabetically.
- **Re-run status preservation**: `rejected` and `skipped` survive
  re-runs; **`approved` and `loaded` do not** — they are overwritten by
  the fresh auto-classification. In practice this only bites with
  `--force`, since already-resolved pairs are otherwise skipped, but it
  differs from the Python version, which also preserves `approved`.
- **Disk cache**: API responses are cached in `.cache/lastfm_search/`,
  `.cache/lastfm_tags/`, `.cache/mb_search/`, `.cache/spotify_search/`
  (md5-keyed JSON files). Note: this conflicts with the project
  preference to track processed state in the database rather than cache
  files — a candidate for cleanup when orchestration is built.
- **Rate limits**: Last.fm ~4 req/s, MusicBrainz 1 req/s (strict),
  Spotify 10 req/s. A full run over ~1,450 artists is dominated by the
  MusicBrainz throttle.

### The review gap

Nothing in the current pipeline processes `close match`, `tie`, or
`pending` rows. `PIPELINE.md` says they are "staged in
`pending_artist_links` for manual review", but there is no current-stack
tool to conduct that review or to promote decisions. The CSV export is a
record, not a review loop. Options today: hand-edit the DB, or use the
legacy tools below (`review_candidates.py export/import` and
`load_links.py` are still schema-compatible).

---

## Pipeline B (legacy) — Python candidate pipeline + `recommender/` package

Imported from an earlier standalone recommendation project. Three CLI
scripts plus a support package:

```
resolve_candidates.py      search + score + classify → pending_artist_links
review_candidates.py       export / import / promote / stats  (human review loop)
load_links.py              promote 'best match' rows → artist_links
recommend.py               query the (legacy) recommendation graph
recommender/
  config.py                env + weights + table names (dotenv; CI-friendly)
  db.py                    psycopg2 helpers; upserts for links, edges, audio features
  scoring.py               the original candidate scoring (rapidfuzz)
  cache.py                 disk JSON cache (.cache/)
  graph.py                 4-pass graph builder → artist_recommendations
  collectors/              lastfm.py, musicbrainz.py, spotify.py
```

Environment: direct Postgres via `SUPABASE_DB_URL` (psycopg2), loaded
from `.env` via python-dotenv. Python deps: `psycopg2`, `rapidfuzz`,
`musicbrainzngs`, `spotipy`, `tqdm`, `numpy`, `python-dotenv` — none of
which are needed by the current stack.

### Candidate matching (steps 1–3)

```bash
python scripts/resolve_candidates.py                  # search/score/classify all artists
python scripts/review_candidates.py export --out candidates.csv
# … edit the status column in a spreadsheet: approved / rejected / skipped …
python scripts/review_candidates.py import --file candidates.csv
python scripts/load_links.py --dry-run                # preview, then run without flag
python scripts/review_candidates.py stats             # progress summary
```

Schema compatibility with today's database:

| Script | Compatible? | Notes |
|---|---|---|
| `resolve_candidates.py` | Yes | Same `pending_artist_links` writes as the Node script; also preserves `approved` on re-runs |
| `review_candidates.py export/import/stats` | Yes | Review loop over `pending_artist_links` |
| `review_candidates.py promote` | **No** | Writes `artist_links(lastfm_name, mbid, spotify_id)` with `ON CONFLICT (artist_id)` — an older schema. Would fail against the current `(artist_id, platform, url)` table. Use `load_links.py` instead. |
| `load_links.py` | Yes | Uses current `(artist_id, platform, url)` schema; marks rows `loaded`. Only loads `best match` — to load `approved` rows it would need a one-word change to its WHERE clause. |
| `recommend.py`, `recommender/graph.py` | **No** | Read/write `artist_recommendations` and `artist_audio_features`, which don't exist in the current schema |

Docstring warning: `review_candidates.py` references a `build_graph.py`
that does not exist in this repo (it was the old project's entry point
for `recommender/graph.py`).

### The legacy recommendation engine (superseded)

`recommender/graph.py` was a complete earlier recommendation engine,
replaced by the current scoring pipeline (`SCORING.md`) and
`/api/discover`:

- Pass 1: resolve Last.fm/MB/Spotify IDs per artist
- Pass 2: Last.fm `artist.getSimilar` → weighted edges
- Pass 3: MusicBrainz artist relations → weighted edges
- Pass 4: Spotify audio features (danceability, energy, valence, …) →
  cosine similarity on already-connected pairs
- Fixed weights from `config.py`; edges written bidirectionally to
  `artist_recommendations`; `recommend.py` queried them
  (`--explain` showed the per-source breakdown)

Note if ever tempted to revive Pass 4: Spotify **deprecated the
audio-features endpoint for new API apps in November 2024**, so this
signal is effectively unavailable now.

---

## What the legacy pipeline has that the current one doesn't

Worth salvaging when streamlining the system:

1. **A working human-review loop.** `review_candidates.py export`
   (with `--service` and `--status` filters) → spreadsheet edit →
   `import` → `load_links.py`. This is exactly the missing piece for the
   current pipeline's `close match` / `tie` / `pending` backlog, and the
   export/import/stats subcommands are schema-compatible today.
2. **`stats` dashboard.** One command shows candidate counts and average
   confidence per service × status, plus how many artists still have no
   links. The current pipeline has no equivalent visibility.
3. **`approved` status preserved on re-runs.** The Python upsert keeps
   all three human decisions (`approved`/`rejected`/`skipped`); the Node
   upsert keeps only `rejected`/`skipped`. If a review loop is added to
   the current pipeline, port this.
4. **Separation of staging and loading.** `load_links.py` is an
   independent, dry-runnable, per-service promote step. The Node script
   couples staging and loading in one run (`--no-load` exists, but there
   is no standalone "load now" invocation without re-running resolution).
5. **Idempotent signal merging.** `recommender/db.py::upsert_edge` uses
   `GREATEST()` per component so a partial re-run never erases a signal
   collected earlier — a good pattern for `push-scores.py` or any future
   incremental scoring.
6. **CI-ready config pattern.** `recommender/config.py` documents running
   from GitHub Actions with secrets as env vars — directly relevant to
   the planned orchestration work.
7. **Per-source score explanation at query time.** `recommend.py
   --explain` returned the per-signal breakdown for each recommendation;
   the current `artist_similarity_scores` table stores only what
   `push-scores.py` writes. Storing component scores alongside the total
   would enable the same debuggability.
8. **Unimplemented but useful idea:** `resolve_candidates.py` mentions
   logging unresolvable ties to an `artist_link_ties` table. Neither
   pipeline implemented it; ties are only visible as log warnings and
   staging rows.

Differences that are *intentional improvements* in the current pipeline
(don't regress these): the ≥ 0.95 auto-load guard, the never-overwrite
check against existing `artist_links`, blank-name skipping, random
`--limit` sampling, and the automatic dated CSV audit trail.

---

## Recommendation

Keep Pipeline A as the resolver. Adopt (or port to Node) the legacy
review loop — `review_candidates.py export/import/stats` +
`load_links.py` — as the official way to work through the staged
non-best-match candidates. Retire `review_candidates.py promote`,
`recommend.py`, and `recommender/graph.py` explicitly, since they target
tables/columns that no longer exist.
