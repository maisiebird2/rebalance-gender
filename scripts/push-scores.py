#!/usr/bin/env python3
"""
push-scores.py

Reads the local pair scores CSV (produced by compute-scores.py), applies
the chosen weights, extracts the top-10 recommendations per artist, and
writes them to the artist_similarity_scores table in the database.

Run this after you're satisfied with compute-scores.py output and have
identified good weights from tune-weights.py.

Usage (from wem-directory/):

    # Use equal weights (0.20 each):
    python scripts/push-scores.py

    # Use weights from tune-weights.py output:
    python scripts/push-scores.py --genre=0.30 --mb-tag=0.25 --mb-collab=0.15 --direct-follow=0.10 --co-follow=0.20

    # Custom input file:
    python scripts/push-scores.py --input=.cache/pair-scores.csv

    # Dry run (compute but don't write to DB):
    DRY_RUN=1 python scripts/push-scores.py

    # Top-N per artist (default 10):
    python scripts/push-scores.py --top-n=15

Requires (in your conda environment):
    conda install numpy pandas requests

To reset the database table before pushing:
    Run in the Supabase SQL editor:
    truncate table artist_similarity_scores;
"""

import sys
import json
import time
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from lib.scoring import make_client

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(description='Push scored artist recommendations to the database')
parser.add_argument('--input',          type=str,   default='.cache/pair-scores.csv', help='Input CSV from compute-scores.py')
parser.add_argument('--genre',          type=float, default=0.20, help='Weight for genre signal (default 0.20)')
parser.add_argument('--mb-tag',         type=float, default=0.20, help='Weight for MB tag signal (default 0.20)')
parser.add_argument('--mb-collab',      type=float, default=0.20, help='Weight for MB collaboration signal (default 0.20)')
parser.add_argument('--direct-follow',  type=float, default=0.20, help='Weight for SC direct follow signal (default 0.20)')
parser.add_argument('--co-follow',      type=float, default=0.20, help='Weight for SC co-follow signal (default 0.20)')
parser.add_argument('--top-n',          type=int,   default=10,   help='Top-N recommendations per artist (default 10)')
parser.add_argument('--debug',          action='store_true',       help='Verbose output')
args = parser.parse_args()

INPUT_PATH = Path(args.input)
TOP_N      = args.top_n
DRY_RUN    = __import__('os').environ.get('DRY_RUN') == '1'

WEIGHTS = np.array([
    args.genre,
    args.mb_tag,
    args.mb_collab,
    args.direct_follow,
    args.co_follow,
])

SIGNAL_COLS = [
    'genre_score',
    'mb_tag_score',
    'mb_collab_score',
    'sc_direct_follow_score',
    'sc_co_follow_score',
]

BATCH_SIZE = 200   # upsert rows per API call

# ---------------------------------------------------------------------------
# Push to DB
# ---------------------------------------------------------------------------
def upsert_batch(client, rows):
    """Upsert a list of score dicts into artist_similarity_scores."""
    r = __import__('requests').post(
        f'{client.base}/rest/v1/artist_similarity_scores',
        headers={
            **client.headers,
            'Content-Type':  'application/json',
            'Prefer':        'resolution=merge-duplicates,return=minimal',
        },
        data=json.dumps(rows),
    )
    if not r.ok:
        raise RuntimeError(f'Supabase {r.status_code} upserting scores: {r.text}')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    weight_sum = WEIGHTS.sum()
    if abs(weight_sum - 1.0) > 0.001:
        print(f'Warning: weights sum to {weight_sum:.4f}, not 1.0. Normalising.')
        WEIGHTS[:] = WEIGHTS / weight_sum

    print('push-scores.py')
    print(f'  Weights: genre={WEIGHTS[0]:.2f}  mb_tag={WEIGHTS[1]:.2f}  mb_collab={WEIGHTS[2]:.2f}  direct_follow={WEIGHTS[3]:.2f}  co_follow={WEIGHTS[4]:.2f}')
    print(f'  Top-{TOP_N} per artist')
    if DRY_RUN:
        print('  DRY RUN — no DB writes')
    print()

    if not INPUT_PATH.exists():
        print(f'Score file not found: {INPUT_PATH}')
        print('Run compute-scores.py first.')
        sys.exit(1)

    print(f'Loading pair scores from {INPUT_PATH}…')
    df = pd.read_csv(INPUT_PATH)
    print(f'  {len(df):,} pairs loaded.')

    # Compute weighted total score
    df['total_score'] = df[SIGNAL_COLS].to_numpy() @ WEIGHTS

    # For each artist, build top-N recommendations (pairs are undirected)
    print(f'Selecting top-{TOP_N} per artist…')
    rows_a = df.rename(columns={'artist_id_a': 'source_artist_id', 'artist_id_b': 'recommended_artist_id'})
    rows_b = df.rename(columns={'artist_id_b': 'source_artist_id', 'artist_id_a': 'recommended_artist_id'})
    both   = pd.concat([rows_a, rows_b], ignore_index=True)

    top = (
        both
        .sort_values('total_score', ascending=False)
        .groupby('source_artist_id')
        .head(TOP_N)
        .copy()
    )
    # Add rank (1 = best) within each source artist's list
    top['rank'] = (
        top.groupby('source_artist_id')['total_score']
        .rank(method='first', ascending=False)
        .astype(int)
    )
    top['computed_at'] = pd.Timestamp.now('UTC').isoformat()
    print(f'  {len(top):,} (source, recommended) rows to write.')

    if args.debug:
        sample = top.nlargest(5, 'total_score')[['source_artist_id', 'recommended_artist_id', 'total_score'] + SIGNAL_COLS]
        print('\nTop 5 pairs:')
        print(sample.to_string(index=False))
        print()

    if DRY_RUN:
        print('Dry run complete — no DB writes.')
        return

    # Write to DB in batches
    print('Upserting to database…')
    client = make_client()
    records = top[['source_artist_id', 'recommended_artist_id', 'total_score', 'rank', 'computed_at'] + SIGNAL_COLS].to_dict('records')

    total, written = len(records), 0
    for start in range(0, total, BATCH_SIZE):
        batch = records[start:start + BATCH_SIZE]
        upsert_batch(client, batch)
        written += len(batch)
        print(f'  {written}/{total}', end='\r')
        time.sleep(0.05)   # be gentle with the API

    print(f'  {written}/{total} rows written.{" " * 20}')
    print('\nDone.')

if __name__ == '__main__':
    main()
