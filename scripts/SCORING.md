# Similarity Scoring

This document covers the process of computing artist similarity scores and
combining signals into them. This is separate from the
enrichment pipeline (see `PIPELINE.md`) — the pipeline populates the signal
tables, and the scoring process reads from them.

The two processes run on different cadences:
- **Enrichment pipeline** — run when you want to refresh profile data
- **Scoring** — run whenever you want to update recommendations, or after
  changing the weights

> **No automated weight tuning.** There used to be a step 2,
> `tune-weights.py`, which grid-searched weight combinations against a
> Last.fm similar-artist validation set. That validation set
> (`lastfm_similar_artists`) and the script were both removed when Last.fm
> data was dropped from the directory — see
> `supabase_migration_remove_lastfm_data.sql`. Weights are now chosen by
> hand and passed to `push-scores.py`. Reinstating automated tuning needs a
> new source of labelled similar-artist pairs (hand-labelled, or derived
> from SoundCloud follow overlap).

---

## Environment setup

Activate your conda environment, then install all required packages:

```bash
conda install numpy pandas requests charset-normalizer
```

| Package | Used by |
|---|---|
| `numpy` | `push-scores.py` — vectorised score computation |
| `pandas` | `push-scores.py` — data manipulation |
| `requests` | all scripts — Supabase REST API calls |
| `charset-normalizer` | `requests` dependency; suppresses a warning if missing |

If you hit a `ModuleNotFoundError` for any of these, install the missing package with `conda install <package-name>`.

---

## Overview

The scoring pipeline has two steps, each a separate Python script:

```
Step 1 │ compute-scores.py  →  .cache/pair-scores.csv
Step 2 │ push-scores.py     →  artist_similarity_scores table in DB
```

Step 1 runs locally with no DB writes. The CSV file is the shared state
between them — you can re-run step 2 with different weights without
re-fetching from the database. Step 2 is the only step that writes to
the database.

---

## Signals

Five signals are combined into a weighted total score:

| Signal | Column | Description |
|---|---|---|
| Genre overlap | `genre_score` | Jaccard similarity on `artist_genres` |
| MusicBrainz tags | `mb_tag_score` | Jaccard similarity on `mb_tags` |
| MB collaborations | `mb_collab_score` | 1 if an edge exists in `mb_collaborations`, else 0 |
| SC direct follow | `sc_direct_follow_score` | 1 if artist A follows B or B follows A in `sc_follow_edges` |
| SC co-follow | `sc_co_follow_score` | Cosine similarity on follower sets — how many directory artists follow both A and B, normalised by the geometric mean of each artist's follower count |

Only pairs where **at least one signal exists** are scored. Pairs with no
shared genres, tags, collabs, or follows are skipped entirely.

The total score is:
```
total_score = w1·genre + w2·mb_tag + w3·mb_collab + w4·direct_follow + w5·co_follow
```

Weights are passed as flags to `push-scores.py` and must sum to 1.0.
Equal weights (0.20 each) are the default and the current baseline; with
no validation set there is nothing to tune them against, so any change
should come from a deliberate judgement about which signals you trust.

---

## Step 1 — `compute-scores.py`

Fetches all signal data from the database, computes the five raw signal
scores for every pair with at least one signal, and writes the results to
a local CSV file. Does not compute weighted totals or write to the DB.

On every DB fetch, signal data is also saved to `.cache/signals.json`.
Subsequent runs with `--cached` load from that file instead of hitting the
database — useful when iterating on scoring logic without changing the
underlying signal data.

```bash
# First run — fetches from DB, caches signals, writes CSV:
python scripts/compute-scores.py

# Re-run using cached signals (no DB calls):
python scripts/compute-scores.py --cached

# Cached + sample 50 artists for a quick debug loop:
python scripts/compute-scores.py --cached --limit=50

# Force re-fetch from DB (e.g. after running the enrichment pipeline):
python scripts/compute-scores.py --refresh

# Verbose output (show sample pairs):
python scripts/compute-scores.py --debug
```

The CSV is written to `.cache/pair-scores.csv` by default. Both cache
files are git-ignored.

When `--limit` is used, the sample is drawn from the full cached set, so
you get a fresh random sample each run. Results from a limited run are
useful for verifying the pipeline end-to-end, but not representative
enough for reliable weight tuning.

---

## Step 2 — `push-scores.py`

Reads the local CSV, applies weights, extracts the top-10 recommendations
per artist, and writes them to `artist_similarity_scores` in the database.

```bash
# Equal weights (default):
python scripts/push-scores.py

# With hand-chosen weights:
python scripts/push-scores.py \
  --genre=0.30 --mb-tag=0.25 --mb-collab=0.15 \
  --direct-follow=0.10 --co-follow=0.20

# Dry run (compute but don't write):
DRY_RUN=1 python scripts/push-scores.py
```

---

## Resetting the database table

When you want to do a full recompute and clear existing scores:

```sql
truncate table artist_similarity_scores;
```

Run this in the Supabase SQL editor, then re-run `push-scores.py`.

---

## Shared library

Signal loading, the Supabase client, pair enumeration, and Jaccard scoring
are in `scripts/lib/scoring.py`. All three scripts import from it.

---

## Notes

- Tuning and scoring can be re-run at any time without touching the
  enrichment data. The signal tables are read-only from the scoring
  pipeline's perspective.
- If you re-run the enrichment pipeline (adding new MB tags, follow edges,
  etc.), re-run `compute-scores.py` to regenerate the local CSV, then
  push the updated scores.
- `compute-scores.mjs` (Node.js) is superseded by the Python pipeline
  and no longer maintained.
- An even earlier recommendation engine (`recommender/graph.py`,
  `recommend.py`, writing to an `artist_recommendations` table that no
  longer exists) is documented in `MATCHING.md` under "legacy".
- Scores pushed by `push-scores.py` are read from
  `artist_similarity_scores` and surfaced as the "similar artists"
  section of each artist page.
