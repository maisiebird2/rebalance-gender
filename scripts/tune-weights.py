#!/usr/bin/env python3
"""
tune-weights.py

Reads pair scores from a local CSV (produced by compute-scores.py) and
the Last.fm similar artists validation set from the database, then
grid-searches over weight combinations to find the weights that best
predict which artists Last.fm considers similar.

After finding the best weights, pass them to push-scores.py.

Usage (from wem-directory/):

    python scripts/tune-weights.py
    python scripts/tune-weights.py --input=.cache/pair-scores.csv
    python scripts/tune-weights.py --step=0.1        # coarser grid (faster)
    python scripts/tune-weights.py --step=0.05       # default
    python scripts/tune-weights.py --top-k=10        # Precision@K (default 10)
    python scripts/tune-weights.py --lfm-top=50      # use top-N LFM similar as positives (default 50)
    python scripts/tune-weights.py --min-validation=3
    python scripts/tune-weights.py --debug

Requires (in your conda environment):
    conda install numpy pandas requests
"""

import sys
import math
import time
import argparse
import itertools
from math import comb
from pathlib import Path
from collections import defaultdict

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from lib.scoring import make_client

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(description='Tune recommendation engine weights')
parser.add_argument('--input',          type=str,   default='.cache/pair-scores.csv', help='Input CSV from compute-scores.py')
parser.add_argument('--step',           type=float, default=0.05,  help='Weight grid step size (default 0.05)')
parser.add_argument('--top-k',          type=int,   default=10,    help='K for Precision@K and NDCG@K (default 10)')
parser.add_argument('--lfm-top',        type=int,   default=50,    help='Use top-N LFM similar artists as positives (default 50)')
parser.add_argument('--min-validation', type=int,   default=3,     help='Min LFM positives in directory to include an artist (default 3)')
parser.add_argument('--debug',          action='store_true',        help='Verbose output during grid search')
args = parser.parse_args()

INPUT_PATH     = Path(args.input)
STEP           = args.step
TOP_K          = args.top_k
LFM_TOP        = args.lfm_top
MIN_VALIDATION = args.min_validation

SIGNAL_COLS = [
    'genre_score',
    'mb_tag_score',
    'mb_collab_score',
    'sc_direct_follow_score',
    'sc_co_follow_score',
]

# ---------------------------------------------------------------------------
# Load validation set from DB
# ---------------------------------------------------------------------------
def load_validation(client, dir_ids):
    print('Loading Last.fm validation set from database…')
    rows = client.get(
        'lastfm_similar_artists',
        'artist_id,similar_artist_id,rank',
        {'similar_artist_id': 'not.is.null', 'rank': f'lte.{LFM_TOP}'},
    )
    validation = defaultdict(set)
    for r in rows:
        if r['similar_artist_id'] in dir_ids:
            validation[r['artist_id']].add(r['similar_artist_id'])

    validation = {
        aid: pos
        for aid, pos in validation.items()
        if len(pos) >= MIN_VALIDATION and aid in dir_ids
    }
    print(f'  {len(validation)} source artists with ≥{MIN_VALIDATION} LFM positives in directory.')
    print(f'  {sum(len(s) for s in validation.values())} total positive pairs.')
    return validation

# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------
def evaluate(weights, candidates_by_artist, validation):
    """
    Given a weight vector (5 floats summing to 1), compute mean
    Precision@K and NDCG@K across all validation source artists.

    candidates_by_artist: dict of source_id →
        numpy array of shape (N, 5) signal scores,
        and list of N recommended artist IDs
    """
    w = np.array(weights)
    precisions, ndcgs = [], []

    for source_id, pos_ids in validation.items():
        entry = candidates_by_artist.get(source_id)
        if entry is None:
            continue
        rec_ids, signal_matrix = entry

        scores   = signal_matrix @ w
        order    = np.argsort(-scores)
        top_k    = [rec_ids[i] for i in order[:TOP_K]]

        hits = sum(1 for aid in top_k if aid in pos_ids)
        precisions.append(hits / TOP_K)

        dcg  = sum(1.0 / math.log2(i + 2) for i, aid in enumerate(top_k) if aid in pos_ids)
        idcg = sum(1.0 / math.log2(i + 2) for i in range(min(len(pos_ids), TOP_K)))
        ndcgs.append(dcg / idcg if idcg > 0 else 0.0)

    mean_p    = float(np.mean(precisions)) if precisions else 0.0
    mean_ndcg = float(np.mean(ndcgs))     if ndcgs      else 0.0
    return mean_p, mean_ndcg

# ---------------------------------------------------------------------------
# Weight combination generator
# ---------------------------------------------------------------------------
def weight_combinations(n=5, step=0.05):
    steps = round(1.0 / step)
    for combo in itertools.combinations_with_replacement(range(steps + 1), n - 1):
        boundaries = (0,) + combo + (steps,)
        weights = tuple(
            (boundaries[i + 1] - boundaries[i]) / steps
            for i in range(n)
        )
        if abs(sum(weights) - 1.0) < 1e-9:
            yield weights

def count_combinations(n=5, step=0.05):
    steps = round(1 / step)
    return comb(steps + n - 1, n - 1)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f'tune-weights.py  step={STEP}  top_k={TOP_K}  lfm_top={LFM_TOP}  min_validation={MIN_VALIDATION}')
    print()

    # Load pair scores from local CSV
    if not INPUT_PATH.exists():
        print(f'Score file not found: {INPUT_PATH}')
        print('Run compute-scores.py first.')
        sys.exit(1)

    print(f'Loading pair scores from {INPUT_PATH}…')
    df = pd.read_csv(INPUT_PATH)
    print(f'  {len(df):,} pairs loaded.')

    # Identify directory artists present in the scores file
    dir_ids = set(df['artist_id_a'].unique()) | set(df['artist_id_b'].unique())
    print(f'  {len(dir_ids)} artists in scores file.')

    # Load validation from DB
    client = make_client()
    validation = load_validation(client, dir_ids)

    if not validation:
        print('\nNo validation data — cannot tune weights.')
        print('Check that fetch-lastfm-similar has been run and similar_artist_id is populated.')
        sys.exit(1)

    # Pre-build candidate matrices per source artist for fast evaluation
    print('\nBuilding candidate matrices…')
    candidates_by_artist = {}
    for source_id in validation:
        # Pairs where source_id is either side
        mask = (df['artist_id_a'] == source_id) | (df['artist_id_b'] == source_id)
        sub  = df[mask].copy()
        if sub.empty:
            continue
        # Determine the "other" artist in each pair
        sub['other_id'] = sub.apply(
            lambda r: r['artist_id_b'] if r['artist_id_a'] == source_id else r['artist_id_a'],
            axis=1,
        )
        rec_ids      = sub['other_id'].tolist()
        signal_matrix = sub[SIGNAL_COLS].to_numpy(dtype=float)
        candidates_by_artist[source_id] = (rec_ids, signal_matrix)

    n_with_candidates = len(candidates_by_artist)
    print(f'  {n_with_candidates} validation artists have candidate pairs in the scores file.')
    if n_with_candidates == 0:
        print('  No overlap between validation artists and scored pairs — cannot evaluate.')
        sys.exit(1)

    # Grid search
    n_combos = count_combinations(n=5, step=STEP)
    print(f'\nGrid search: {n_combos:,} weight combinations…')
    print(f'Signals: [genre, mb_tag, mb_collab, direct_follow, co_follow]\n')

    best_p, best_ndcg   = -1.0, -1.0
    best_w_p = best_w_ndcg = None
    top_results = []

    start = time.time()
    for i, weights in enumerate(weight_combinations(n=5, step=STEP)):
        p, ndcg = evaluate(weights, candidates_by_artist, validation)

        top_results.append((p, ndcg, weights))
        top_results.sort(reverse=True)
        top_results = top_results[:20]

        if p > best_p or (p == best_p and ndcg > best_ndcg):
            best_p, best_ndcg = p, ndcg
            best_w_p = weights
        if ndcg > best_ndcg:
            best_ndcg = ndcg
            best_w_ndcg = weights

        if args.debug and i % 500 == 0:
            elapsed = time.time() - start
            eta = (n_combos - i - 1) / ((i + 1) / elapsed) if elapsed > 0 else 0
            print(f'  [{i+1}/{n_combos}] best P@{TOP_K}={best_p:.4f}  eta={eta:.0f}s', end='\r')

    elapsed = time.time() - start
    print(f'  Done in {elapsed:.1f}s.{" " * 40}')

    # Report
    print()
    print('─' * 60)
    print(f'Best by Precision@{TOP_K}:')
    w = best_w_p
    print(f'  genre={w[0]:.2f}  mb_tag={w[1]:.2f}  mb_collab={w[2]:.2f}  direct_follow={w[3]:.2f}  co_follow={w[4]:.2f}')
    print(f'  Precision@{TOP_K} = {best_p:.4f}   NDCG@{TOP_K} = {best_ndcg:.4f}')

    if best_w_ndcg and best_w_ndcg != best_w_p:
        w = best_w_ndcg
        p2, n2 = evaluate(w, candidates_by_artist, validation)
        print(f'\nBest by NDCG@{TOP_K}:')
        print(f'  genre={w[0]:.2f}  mb_tag={w[1]:.2f}  mb_collab={w[2]:.2f}  direct_follow={w[3]:.2f}  co_follow={w[4]:.2f}')
        print(f'  Precision@{TOP_K} = {p2:.4f}   NDCG@{TOP_K} = {n2:.4f}')

    print(f'\nTop 10 by Precision@{TOP_K}:')
    print(f'  {"P@K":>6}  {"NDCG":>6}  genre  mb_tag  mb_collab  direct  co_follow')
    for p, ndcg, w in top_results[:10]:
        print(f'  {p:.4f}  {ndcg:.4f}  {w[0]:.2f}   {w[1]:.2f}    {w[2]:.2f}      {w[3]:.2f}    {w[4]:.2f}')

    w = best_w_p
    print(f'\nTo push scores to the database, run:')
    print(
        f'  python scripts/push-scores.py '
        f'--genre={w[0]} --mb-tag={w[1]} --mb-collab={w[2]} '
        f'--direct-follow={w[3]} --co-follow={w[4]}'
    )

if __name__ == '__main__':
    main()
