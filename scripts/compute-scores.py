#!/usr/bin/env python3
"""
compute-scores.py

Fetches all signal data from the database, computes pairwise similarity
scores for every pair of approved directory artists with at least one
signal, and saves the results to a local CSV file.

Run this first, then tune-weights.py to find the best weights, then
push-scores.py to write the final scores to the database.

The CSV contains raw signal scores (not weighted totals) so that
tune-weights.py can explore different weight combinations without
re-fetching from the DB.

Usage (from rebalance-gender/):

    python scripts/compute-scores.py                  # fetch from DB, cache signals, write CSV
    python scripts/compute-scores.py --cached         # use cached signals, no DB calls
    python scripts/compute-scores.py --cached --limit=50   # cached + sample 50 artists
    python scripts/compute-scores.py --refresh        # force re-fetch from DB, overwrite cache
    python scripts/compute-scores.py --debug          # print sample pairs

On the first run, signal data is fetched from the database and saved to
.cache/signals.json. Subsequent runs with --cached skip all DB calls and
load from that file instead, making iteration on scoring logic much faster.

Use --refresh to force a re-fetch when the underlying signal data has
changed (e.g. after running the enrichment pipeline).

When --limit is used, only pairs where BOTH artists are in the sampled
set are scored. Sampling is applied after loading, so --cached --limit=50
draws a fresh random sample from the full cached set each run.

Requires (in your conda environment):
    conda install numpy pandas requests
"""

import sys
import csv
import random
import argparse
from pathlib import Path

# Allow importing from scripts/lib/
sys.path.insert(0, str(Path(__file__).parent))
from lib.scoring import (
    make_client, load_directory_artists, load_all_signals, build_pair_scores,
    save_signals_cache, load_signals_cache, DEFAULT_SIGNALS_CACHE, SCORE_COLUMNS,
)

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(description='Compute pairwise artist similarity scores')
parser.add_argument('--limit',   type=int,   default=None,                      help='Random sample of N artists (debug mode)')
parser.add_argument('--output',  type=str,   default='.cache/pair-scores.csv',  help='Output CSV path (default: .cache/pair-scores.csv)')
parser.add_argument('--cached',  action='store_true',                            help='Load signal data from .cache/signals.json instead of fetching from DB')
parser.add_argument('--refresh', action='store_true',                            help='Force re-fetch from DB and overwrite the signal cache')
parser.add_argument('--debug',   action='store_true',                            help='Verbose output')
args = parser.parse_args()

OUTPUT_PATH = Path(args.output)
OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print('compute-scores.py')
    if args.limit:
        print(f'  Limit: {args.limit} artists.')
    if args.cached:
        print(f'  Using cached signal data (--cached).')
    print()

    use_cache = args.cached and not args.refresh

    if use_cache:
        # Load all signal data from local cache — no DB calls
        if not DEFAULT_SIGNALS_CACHE.exists():
            print(f'Cache file not found: {DEFAULT_SIGNALS_CACHE}')
            print('Run without --cached first to populate the cache.')
            import sys; sys.exit(1)
        print(f'Loading signal data from cache ({DEFAULT_SIGNALS_CACHE})…')
        all_dir_ids, id_to_name, signals = load_signals_cache()
        print(f'  {len(all_dir_ids)} artists in cache.')
    else:
        # Fetch from DB and save to cache
        client = make_client()
        print('Loading directory artists…')
        all_dir_ids, id_to_name = load_directory_artists(client)
        print(f'  {len(all_dir_ids)} approved artists.')
        print('\nLoading signal data…')
        signals = load_all_signals(client, all_dir_ids)
        print('\nSaving signal cache…')
        save_signals_cache(all_dir_ids, id_to_name, signals)

    # Apply --limit sampling on top of whatever set we have
    if args.limit and len(all_dir_ids) > args.limit:
        sampled = set(random.sample(sorted(all_dir_ids), args.limit))
        dir_ids = sampled
        id_to_name = {k: v for k, v in id_to_name.items() if k in sampled}
        print(f'\nSampling {len(dir_ids)} of {len(all_dir_ids)} artists.')
    else:
        dir_ids = all_dir_ids

    # Build pair scores
    print('\nBuilding pairs and computing scores…')

    rows = build_pair_scores(dir_ids, signals)
    print(f'  {len(rows):,} pairs scored.')

    if args.debug:
        # Show a sample of pairs with non-zero scores
        sample = [r for r in rows if any(v > 0 for v in r[2:])][:5]
        for r in sample:
            name_a = id_to_name.get(r[0], r[0][:8])
            name_b = id_to_name.get(r[1], r[1][:8])
            print(f'  {name_a} ↔ {name_b}: genre={r[2]:.3f} mb_tag={r[3]:.3f} collab={r[4]:.0f} direct={r[5]:.0f} co={r[6]:.3f}')

    # Write CSV
    print(f'\nWriting to {OUTPUT_PATH}…')
    with open(OUTPUT_PATH, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(SCORE_COLUMNS)
        writer.writerows(rows)
    print(f'  Done. {len(rows):,} rows written.')
    print(f'\nNext step: python scripts/tune-weights.py --input={OUTPUT_PATH}')

if __name__ == '__main__':
    main()
