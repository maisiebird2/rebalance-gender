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

## Overview

```
Step 1 │ Compute raw signal scores → artist_similarity_scores
Step 2 │ Tune weights (Python, offline analysis)
Step 3 │ Update weights in compute-scores.mjs, re-run with --force
```

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

Weights are defined at the top of `compute-scores.mjs` and must sum to 1.0.
The initial values are equal weights (0.20 each) — update them after running
`tune-weights.py`.

---

## Step 1 — `compute-scores.mjs`

Reads all signal tables, scores every pair with at least one signal, and
writes the top-10 recommendations per artist into `artist_similarity_scores`.

```bash
npm run compute-scores                # score artists that don't have scores yet
npm run compute-scores -- --force    # recompute scores for all artists
npm run compute-scores -- --debug    # verbose output
DRY_RUN=1 npm run compute-scores     # compute but don't write to DB
```

**Without `--force`:** skips artists that already have rows in
`artist_similarity_scores`. Use this when new artists have been added and
you want to score only the newcomers.

**With `--force`:** recomputes scores for all artists and overwrites existing
rows. Use this after updating the weights in `compute-scores.mjs`.

**To reset the table entirely** before a full recompute, run this in the
Supabase SQL editor:

```sql
truncate table artist_similarity_scores;
```

Then run `npm run compute-scores` (without `--force` — the table is empty so
all artists will be scored regardless).

---

## Step 2 — `tune-weights.py`

Reads raw signal data directly from the signal tables (not from
`artist_similarity_scores` — that only stores the current top-10, which
would bias the search). Recomputes scores for all candidate pairs from
scratch, then grid-searches over weight combinations to find the weights
that best predict the Last.fm validation set.

Reports Precision@K and NDCG@K for the best combinations, and prints a
ready-to-paste `WEIGHTS` block for `compute-scores.mjs`.

No DB writes — purely analytical output.

```bash
# Install dependencies first (once, inside your conda environment):
conda install numpy
pip install requests

python scripts/tune-weights.py
python scripts/tune-weights.py --step=0.1       # coarser grid, faster
python scripts/tune-weights.py --top-k=10       # default
python scripts/tune-weights.py --lfm-top=50     # use top-50 LFM similar as positives (default)
python scripts/tune-weights.py --debug          # show progress during grid search
```

**`--step`** controls grid granularity. At `0.05` (default) there are ~10,600
weight combinations; at `0.1` there are ~126. Start coarse to sanity-check,
then refine.

**`--lfm-top`** controls how many of Last.fm's similar artists count as
"ground truth positives" for each source artist. Lower values (e.g. 20) use
only the most confident LFM matches; higher values (e.g. 100) include weaker
ones.

**`--min-validation`** skips source artists with fewer than N LFM positives
in our directory (default 3). Too few positives makes Precision@K noisy.

---

## Step 3 — Update weights and recompute

After `tune-weights.py` identifies the best weights, open `compute-scores.mjs`
and update the `WEIGHTS` constant near the top of the file:

```js
const WEIGHTS = {
  genre:        0.20,   // ← update these
  mbTag:        0.20,
  mbCollab:     0.20,
  directFollow: 0.20,
  coFollow:     0.20,
}
```

Then truncate the table and recompute:

```sql
truncate table artist_similarity_scores;
```

```bash
npm run compute-scores
```

---

## Notes

- Tuning and scoring can be re-run at any time without touching the enrichment
  data. The signal tables (`artist_genres`, `mb_tags`, etc.) are read-only
  from the scoring process's perspective.
- If you re-run the enrichment pipeline (adding new MB tags, follow edges,
  etc.), run `compute-scores` afterwards to refresh the scores.
- The `lastfm_similar_artists` validation set is deliberately kept separate
  from the scoring inputs — it is used only for tuning, never as a live signal.
