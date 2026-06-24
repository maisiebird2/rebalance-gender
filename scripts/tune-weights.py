#!/usr/bin/env python3
"""
tune-weights.py

Loads raw signal data from the database, computes pairwise similarity
scores for all candidate pairs, then grid-searches over weight combinations
to find the weights that best predict which artists Last.fm considers similar.

The script does NOT read from artist_similarity_scores — those only store the
top-10 per artist under the current weights, which would bias the search.
Instead it reads directly from the signal tables (artist_genres, mb_tags,
mb_collaborations, sc_follow_edges) and recomputes scores from scratch.

After finding the best weights, copy them into the WEIGHTS constant in
compute-scores.mjs and re-run that script with --force.

Usage (from wem-directory/):

    python scripts/tune-weights.py
    python scripts/tune-weights.py --step=0.1       # coarser grid (faster)
    python scripts/tune-weights.py --step=0.05      # default
    python scripts/tune-weights.py --top-k=10       # Precision@K (default 10)
    python scripts/tune-weights.py --lfm-top=50     # use top-N LFM similar as positives (default 50)
    python scripts/tune-weights.py --min-validation=3  # min LFM positives in directory to include artist (default 3)
    python scripts/tune-weights.py --debug

Requires (inside your conda environment):
    conda install numpy
    pip install requests
"""

import os
import sys
import math
import time
import argparse
import itertools
from collections import defaultdict
from pathlib import Path

import numpy as np
import requests

# ---------------------------------------------------------------------------
# CLI args
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(description='Tune recommendation engine weights')
parser.add_argument('--step',           type=float, default=0.05,  help='Weight grid step size (default 0.05)')
parser.add_argument('--top-k',          type=int,   default=10,    help='K for Precision@K (default 10)')
parser.add_argument('--lfm-top',        type=int,   default=50,    help='Use top-N LFM similar artists as positives (default 50)')
parser.add_argument('--min-validation', type=int,   default=3,     help='Min LFM positives in directory to include an artist in the evaluation (default 3)')
parser.add_argument('--debug',          action='store_true',        help='Verbose output')
args = parser.parse_args()

STEP           = args.step
TOP_K          = args.top_k
LFM_TOP        = args.lfm_top
MIN_VALIDATION = args.min_validation
DEBUG          = args.debug

# ---------------------------------------------------------------------------
# Load .env.local
# ---------------------------------------------------------------------------
def load_env_local():
    env_path = Path(__file__).parent.parent / '.env.local'
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, _, value = line.partition('=')
        key   = key.strip()
        value = value.strip().strip('"').strip("'")
        if key not in os.environ:
            os.environ[key] = value

load_env_local()

SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
SECRET_KEY   = os.environ.get('SUPABASE_SECRET_KEY')

if not SUPABASE_URL or not SECRET_KEY:
    print('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local')
    sys.exit(1)

# ---------------------------------------------------------------------------
# Supabase REST client (paginated)
# ---------------------------------------------------------------------------
HEADERS = {
    'apikey':        SECRET_KEY,
    'Authorization': f'Bearer {SECRET_KEY}',
    'Accept':        'application/json',
}
PAGE_SIZE = 1000

def sb_get(table, select, extra_params=None):
    """Fetch all rows from a Supabase table, paginating automatically."""
    rows   = []
    offset = 0
    while True:
        params = {'select': select, 'limit': PAGE_SIZE, 'offset': offset}
        if extra_params:
            params.update(extra_params)
        r = requests.get(
            f'{SUPABASE_URL}/rest/v1/{table}',
            headers=HEADERS,
            params=params,
        )
        r.raise_for_status()
        page = r.json()
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def pair_key(id_a, id_b):
    """Canonical pair key: lower UUID first."""
    return (id_a, id_b) if id_a < id_b else (id_b, id_a)

def jaccard(set_a, set_b):
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a & set_b)
    return inter / (len(set_a) + len(set_b) - inter)

# ---------------------------------------------------------------------------
# Load signal data
# ---------------------------------------------------------------------------
def load_data():
    print('Loading approved directory artists…')
    artist_rows = sb_get('artists', 'id,name', {'directory_status': 'eq.approved'})
    dir_ids     = {r['id'] for r in artist_rows}
    id_to_name  = {r['id']: r['name'] for r in artist_rows}
    print(f'  {len(dir_ids)} artists.')

    print('Loading artist genres…')
    genre_rows = sb_get('artist_genres', 'artist_id,genre',
                         {f'artist_id': f'in.({",".join(dir_ids)})'})
    artist_genres = defaultdict(set)
    for r in genre_rows:
        artist_genres[r['artist_id']].add(r['genre'])
    print(f'  {len(genre_rows)} genre assignments.')

    print('Loading MusicBrainz tags…')
    tag_rows = sb_get('mb_tags', 'artist_id,tag',
                       {f'artist_id': f'in.({",".join(dir_ids)})'})
    artist_mb_tags = defaultdict(set)
    for r in tag_rows:
        artist_mb_tags[r['artist_id']].add(r['tag'])
    print(f'  {len(tag_rows)} tag assignments.')

    print('Loading MusicBrainz collaborations…')
    collab_rows = sb_get('mb_collaborations', 'artist_id_a,artist_id_b')
    collab_pairs = {
        pair_key(r['artist_id_a'], r['artist_id_b'])
        for r in collab_rows
        if r['artist_id_a'] in dir_ids and r['artist_id_b'] in dir_ids
    }
    print(f'  {len(collab_pairs)} collaboration edges.')

    print('Loading SoundCloud follow edges (directory→directory)…')
    # Fetch in two passes since the in() filter on two columns needs separate calls
    edge_rows = sb_get('sc_follow_edges', 'follower_artist_id,followed_artist_id',
                        {'follower_artist_id': f'in.({",".join(dir_ids)})',
                         'followed_artist_id': f'in.({",".join(dir_ids)})'})
    direct_edges = {
        (r['follower_artist_id'], r['followed_artist_id'])
        for r in edge_rows
    }
    # followersOf[artist_id] = set of directory artists who follow them
    followers_of = defaultdict(set)
    following_lists = defaultdict(list)  # follower → list of followed dir artists
    for r in edge_rows:
        followers_of[r['followed_artist_id']].add(r['follower_artist_id'])
        following_lists[r['follower_artist_id']].append(r['followed_artist_id'])
    print(f'  {len(direct_edges)} follow edges.')

    return {
        'dir_ids':       dir_ids,
        'id_to_name':    id_to_name,
        'genres':        dict(artist_genres),
        'mb_tags':       dict(artist_mb_tags),
        'collab_pairs':  collab_pairs,
        'direct_edges':  direct_edges,
        'followers_of':  dict(followers_of),
        'following_lists': dict(following_lists),
    }

# ---------------------------------------------------------------------------
# Build pairs and raw signal scores
# ---------------------------------------------------------------------------
def build_pair_scores(data):
    dir_ids       = data['dir_ids']
    genres        = data['genres']
    mb_tags       = data['mb_tags']
    collab_pairs  = data['collab_pairs']
    direct_edges  = data['direct_edges']
    followers_of  = data['followers_of']
    following_lists = data['following_lists']

    # Enumerate pairs with at least one signal
    pairs = set()

    def add_pairs_from_index(index):
        for artists in index.values():
            arr = list(artists)
            for i in range(len(arr)):
                for j in range(i + 1, len(arr)):
                    pairs.add(pair_key(arr[i], arr[j]))

    # Genre pairs
    genre_index = defaultdict(list)
    for aid, gs in genres.items():
        for g in gs:
            genre_index[g].append(aid)
    add_pairs_from_index(genre_index)

    # MB tag pairs
    tag_index = defaultdict(list)
    for aid, ts in mb_tags.items():
        for t in ts:
            tag_index[t].append(aid)
    add_pairs_from_index(tag_index)

    # MB collab pairs
    pairs.update(collab_pairs)

    # SC direct follow pairs
    for (follower, followed) in direct_edges:
        pairs.add(pair_key(follower, followed))

    # SC co-follow pairs + counts
    co_follow_counts = defaultdict(int)
    for followed_list in following_lists.values():
        arr = followed_list
        for i in range(len(arr)):
            for j in range(i + 1, len(arr)):
                key = pair_key(arr[i], arr[j])
                pairs.add(key)
                co_follow_counts[key] += 1

    print(f'  {len(pairs):,} pairs with at least one signal.')
    print(f'  {len(co_follow_counts):,} pairs with co-follow signal.')

    # Compute raw signal scores for every pair
    # Returns dict: pair_key → (genre, mb_tag, mb_collab, direct_follow, co_follow)
    pair_scores = {}
    for (id_a, id_b) in pairs:
        key = (id_a, id_b)

        genre_s  = jaccard(genres.get(id_a, set()), genres.get(id_b, set()))
        tag_s    = jaccard(mb_tags.get(id_a, set()), mb_tags.get(id_b, set()))
        collab_s = 1.0 if key in collab_pairs else 0.0

        direct_s = 1.0 if (
            (id_a, id_b) in direct_edges or (id_b, id_a) in direct_edges
        ) else 0.0

        co_count = co_follow_counts.get(key, 0)
        fa = len(followers_of.get(id_a, set()))
        fb = len(followers_of.get(id_b, set()))
        co_s = (co_count / math.sqrt(fa * fb)) if fa > 0 and fb > 0 else 0.0
        co_s = min(co_s, 1.0)

        pair_scores[key] = (genre_s, tag_s, collab_s, direct_s, co_s)

    return pair_scores

# ---------------------------------------------------------------------------
# Load LFM validation set
# ---------------------------------------------------------------------------
def load_validation(dir_ids):
    print('Loading Last.fm validation set…')
    rows = sb_get(
        'lastfm_similar_artists',
        'artist_id,similar_artist_id,rank',
        {
            'similar_artist_id': 'not.is.null',
            'rank':              f'lte.{LFM_TOP}',
        }
    )
    # validation[source_artist_id] = set of similar artist IDs in our directory
    validation = defaultdict(set)
    for r in rows:
        if r['similar_artist_id'] in dir_ids:
            validation[r['artist_id']].add(r['similar_artist_id'])

    # Filter to artists with enough validation data
    validation = {
        aid: pos_set
        for aid, pos_set in validation.items()
        if len(pos_set) >= MIN_VALIDATION
    }
    print(f'  {len(validation)} source artists with ≥{MIN_VALIDATION} LFM positives in directory.')
    total_positives = sum(len(s) for s in validation.values())
    print(f'  {total_positives} total positive pairs.')
    return validation

# ---------------------------------------------------------------------------
# Evaluate a set of weights
# ---------------------------------------------------------------------------
def evaluate(weights, pair_scores, validation, dir_ids):
    """Returns mean Precision@K and mean NDCG@K across all validation artists."""
    w = np.array(weights)

    precisions = []
    ndcgs      = []

    for source_id, positive_ids in validation.items():
        # Collect all candidate pairs for this source artist
        candidates = []
        for (id_a, id_b), signals in pair_scores.items():
            if id_a == source_id:
                other = id_b
            elif id_b == source_id:
                other = id_a
            else:
                continue
            if other not in dir_ids:
                continue
            score = float(np.dot(w, signals))
            candidates.append((score, other))

        if not candidates:
            continue

        candidates.sort(reverse=True)
        top_k = [other for _, other in candidates[:TOP_K]]

        # Precision@K
        hits = sum(1 for aid in top_k if aid in positive_ids)
        precisions.append(hits / TOP_K)

        # NDCG@K
        dcg  = sum(
            1.0 / math.log2(i + 2)
            for i, aid in enumerate(top_k)
            if aid in positive_ids
        )
        # Ideal DCG: all positives ranked at the top (capped at K)
        ideal_hits = min(len(positive_ids), TOP_K)
        idcg = sum(1.0 / math.log2(i + 2) for i in range(ideal_hits))
        ndcgs.append(dcg / idcg if idcg > 0 else 0.0)

    mean_p   = float(np.mean(precisions)) if precisions else 0.0
    mean_ndcg = float(np.mean(ndcgs))    if ndcgs      else 0.0
    return mean_p, mean_ndcg

# ---------------------------------------------------------------------------
# Weight combination generator
# ---------------------------------------------------------------------------
def weight_combinations(n_signals=5, step=0.05):
    """Yield all n-tuples of non-negative multiples of step that sum to 1.0."""
    steps = round(1.0 / step)
    # Stars-and-bars: find all ways to distribute `steps` units across n_signals slots
    for combo in itertools.combinations_with_replacement(range(steps + 1), n_signals - 1):
        boundaries = (0,) + combo + (steps,)
        weights = tuple(
            (boundaries[i + 1] - boundaries[i]) / steps
            for i in range(n_signals)
        )
        if abs(sum(weights) - 1.0) < 1e-9:
            yield weights

# Count combinations for progress reporting
def count_combinations(n=5, step=0.05):
    steps = round(1 / step)
    # C(steps + n - 1, n - 1)
    from math import comb
    return comb(steps + n - 1, n - 1)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f'tune-weights.py  step={STEP}  top_k={TOP_K}  lfm_top={LFM_TOP}  min_validation={MIN_VALIDATION}')
    print()

    # Load data
    data = load_data()

    print('\nBuilding pair set and computing raw signal scores…')
    pair_scores = build_pair_scores(data)
    print(f'  {len(pair_scores):,} pairs scored.')

    print()
    validation = load_validation(data['dir_ids'])

    if not validation:
        print('\nNo validation data — cannot tune weights.')
        print('Check that fetch-lastfm-similar has been run and similar_artist_id is populated.')
        sys.exit(1)

    # Grid search
    n_combos = count_combinations(n=5, step=STEP)
    print(f'\nGrid search: {n_combos:,} weight combinations at step={STEP}…')
    print('Signals: [genre, mb_tag, mb_collab, direct_follow, co_follow]\n')

    best_p      = -1.0
    best_ndcg   = -1.0
    best_weights_p    = None
    best_weights_ndcg = None

    top_results = []  # keep top-20 by precision for reporting

    start = time.time()
    for i, weights in enumerate(weight_combinations(n_signals=5, step=STEP)):
        p, ndcg = evaluate(weights, pair_scores, validation, data['dir_ids'])

        top_results.append((p, ndcg, weights))
        top_results.sort(reverse=True)
        top_results = top_results[:20]

        if p > best_p or (p == best_p and ndcg > best_ndcg):
            best_p       = p
            best_ndcg    = ndcg
            best_weights_p = weights

        if ndcg > best_ndcg:
            best_ndcg         = ndcg
            best_weights_ndcg = weights

        if DEBUG and i % 500 == 0:
            elapsed = time.time() - start
            rate    = (i + 1) / elapsed if elapsed > 0 else 0
            eta     = (n_combos - i - 1) / rate if rate > 0 else 0
            print(f'  [{i+1}/{n_combos}] best P@{TOP_K}={best_p:.4f}  eta={eta:.0f}s', end='\r')

    elapsed = time.time() - start
    print(f'  Done in {elapsed:.1f}s.{" " * 30}')

    # Results
    print()
    print('─' * 60)
    print(f'Best by Precision@{TOP_K}:')
    w = best_weights_p
    print(f'  genre={w[0]:.2f}  mb_tag={w[1]:.2f}  mb_collab={w[2]:.2f}  direct_follow={w[3]:.2f}  co_follow={w[4]:.2f}')
    print(f'  Precision@{TOP_K} = {best_p:.4f}   NDCG@{TOP_K} = {best_ndcg:.4f}')

    if best_weights_ndcg and best_weights_ndcg != best_weights_p:
        w = best_weights_ndcg
        print(f'\nBest by NDCG@{TOP_K}:')
        print(f'  genre={w[0]:.2f}  mb_tag={w[1]:.2f}  mb_collab={w[2]:.2f}  direct_follow={w[3]:.2f}  co_follow={w[4]:.2f}')
        p2, ndcg2 = evaluate(w, pair_scores, validation, data['dir_ids'])
        print(f'  Precision@{TOP_K} = {p2:.4f}   NDCG@{TOP_K} = {ndcg2:.4f}')

    print(f'\nTop 10 weight combinations by Precision@{TOP_K}:')
    print(f'  {"P@K":>6}  {"NDCG":>6}  genre  mb_tag  mb_collab  direct  co_follow')
    for p, ndcg, w in top_results[:10]:
        print(f'  {p:.4f}  {ndcg:.4f}  {w[0]:.2f}   {w[1]:.2f}    {w[2]:.2f}      {w[3]:.2f}    {w[4]:.2f}')

    print()
    print('To apply the best weights, update WEIGHTS in compute-scores.mjs:')
    w = best_weights_p
    print(f"""
const WEIGHTS = {{
  genre:        {w[0]:.2f},
  mbTag:        {w[1]:.2f},
  mbCollab:     {w[2]:.2f},
  directFollow: {w[3]:.2f},
  coFollow:     {w[4]:.2f},
}}""")
    print('\nThen run: truncate table artist_similarity_scores;')
    print('         npm run compute-scores')

if __name__ == '__main__':
    main()
