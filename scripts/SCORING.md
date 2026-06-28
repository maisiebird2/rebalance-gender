# Similarity Scoring

This document covers the process of computing artist similarity scores and
tuning the weights used to combine signals. This is separate from the
enrichment pipeline (see `PIPELINE.md`) — the pipeline populates the signal
tables, and the scoring process reads from them.

The two processes run on different cadences:
- **Enrichment pipeline** — run when you want to refresh profile data
- **Scoring** — run whenever you want to update recommendations, or after
  re-tuning the weights

---

## Environment setup

Activate your conda environment, then install all required packages:

```bash
conda install numpy pandas requests charset-normalizer
```

| Package | Used by |
|---|---|
| `numpy` | `tune-weights.py` — vectorised score computation |
| `pandas` | `tune-weights.py`, `push-scores.py` — data manipulation |
| `requests` | all scripts — Supabase REST API calls |
| `charset-normalizer` | `requests` dependency; suppresses a warning if missing |

If you hit a `ModuleNotFoundError` for any of these, install the missing package with `conda install <package-name>`.

---

## Overview

The scoring pipeline has three steps, each a separate Python script:

```
Step 1 │ compute-scores.py  →  .cache/pair-scores.csv
Step 2 │ tune-weights.py    →  best weights (printed to terminal)
Step 3 │ push-scores.py     →  artist_similarity_scores table in DB
```

Steps 1 and 2 run locally with no DB writes. The CSV file is the shared
state between them — you can re-run step 2 with different parameters
without re-fetching from the database. Step 3 is the only step that
writes to the database.

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
Before tuning, use equal weights (0.20 each). After tuning, use the
values reported by `tune-weights.py`.

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

## Step 2 — `tune-weights.py`

Reads pair scores from the local CSV and the Last.fm similar artists
validation set from the database. Grid-searches over weight combinations
to find the weights that best predict which artists Last.fm considers
similar. Reports Precision@K and NDCG@K, and prints a ready-to-use
`push-scores.py` command with the best weights.

No DB writes.

```bash
python scripts/tune-weights.py
python scripts/tune-weights.py --step=0.1       # coarser grid, faster
python scripts/tune-weights.py --step=0.05      # default (~10,600 combos)
python scripts/tune-weights.py --top-k=10       # default
python scripts/tune-weights.py --lfm-top=50     # use top-50 LFM similar as positives (default)
python scripts/tune-weights.py --debug          # show progress during grid search
```

**`--step`** controls grid granularity. Start coarse (`0.1`) to sanity-check,
then refine (`0.05` or smaller).

**`--lfm-top`** controls how many of Last.fm's similar artists count as
positives per source artist. Lower values use only the most confident
LFM matches.

**`--min-validation`** skips source artists with fewer than N LFM positives
in our directory (default 3). Too few positives makes Precision@K noisy.

---

## Step 3 — `push-scores.py`

Reads the local CSV, applies weights, extracts the top-10 recommendations
per artist, and writes them to `artist_similarity_scores` in the database.

```bash
# Equal weights (default):
python scripts/push-scores.py

# With weights from tune-weights.py:
python scripts/push-scores.py \
  --genre=0.30 --mb-tag=0.25 --mb-collab=0.15 \
  --direct-follow=0.10 --co-follow=0.20

# Dry run (compute but don't write):
DRY_RUN=1 python scripts/push-scores.py
```

`tune-weights.py` prints the exact `push-scores.py` command to run at the
end of its output — copy-paste it directly.

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
- The `lastfm_similar_artists` validation set is deliberately kept separate
  from the scoring signals — it is used only for tuning.
- `compute-scores.mjs` (Node.js) is superseded by the Python pipeline
  and no longer maintained.
