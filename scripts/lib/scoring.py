"""
lib/scoring.py

Shared utilities for the scoring pipeline:
  compute-scores.py  →  tune-weights.py  →  push-scores.py

Provides:
  - Environment loading (.env.local)
  - Supabase REST API client with pagination
  - Signal data loading functions
  - Pair key helpers
  - Jaccard similarity
  - build_pair_scores() — the core pair enumeration and scoring logic
"""

import os
import json
import math
import requests
from pathlib import Path
from collections import defaultdict


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

def load_env_local():
    """Load variables from .env.local into os.environ (does not overwrite)."""
    env_path = Path(__file__).parent.parent.parent / '.env.local'
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key   = key.strip()
        value = value.strip().strip('"').strip("'")
        if key not in os.environ:
            os.environ[key] = value


# ---------------------------------------------------------------------------
# Supabase REST client
# ---------------------------------------------------------------------------

PAGE_SIZE = 1000

class SupabaseClient:
    def __init__(self, url, key):
        self.base = url.rstrip('/')
        self.headers = {
            'apikey':        key,
            'Authorization': f'Bearer {key}',
            'Accept':        'application/json',
        }

    def get(self, table, select, params=None):
        """Fetch all rows from a table, paginating automatically."""
        rows   = []
        offset = 0
        while True:
            p = {'select': select, 'limit': PAGE_SIZE, 'offset': offset}
            if params:
                p.update(params)
            r = requests.get(
                f'{self.base}/rest/v1/{table}',
                headers=self.headers,
                params=p,
            )
            if not r.ok:
                raise RuntimeError(f'Supabase {r.status_code} fetching {table}: {r.text}')
            page = r.json()
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
        return rows


def make_client():
    """Create a SupabaseClient from environment variables."""
    load_env_local()
    url = os.environ.get('NEXT_PUBLIC_SUPABASE_URL')
    key = os.environ.get('SUPABASE_SECRET_KEY')
    if not url or not key:
        raise RuntimeError('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local')
    return SupabaseClient(url, key)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def pair_key(id_a, id_b):
    """Canonical pair: always (lower, higher) UUID string."""
    return (id_a, id_b) if id_a < id_b else (id_b, id_a)


def jaccard(set_a, set_b):
    """Jaccard similarity between two sets."""
    if not set_a or not set_b:
        return 0.0
    inter = len(set_a & set_b)
    return inter / (len(set_a) + len(set_b) - inter)


# ---------------------------------------------------------------------------
# Signal data loading
# ---------------------------------------------------------------------------

def load_directory_artists(client, limit_ids=None):
    """
    Return (dir_ids, id_to_name) for all approved directory artists.
    Pass limit_ids (a set of IDs) to restrict to a debug subset.
    """
    rows = client.get('artists', 'id,name', {'directory_status': 'eq.approved'})
    if limit_ids:
        rows = [r for r in rows if r['id'] in limit_ids]
    dir_ids    = {r['id'] for r in rows}
    id_to_name = {r['id']: r['name'] for r in rows}
    return dir_ids, id_to_name


def load_artist_genres(client, dir_ids):
    """Return dict: artist_id → set of genre name strings."""
    # genres is a normalised table; artist_genres stores genre_id FK
    genre_lookup = {
        r['id']: r['name']
        for r in client.get('genres', 'id,name')
    }
    rows = client.get('artist_genres', 'artist_id,genre_id')
    result = defaultdict(set)
    for r in rows:
        if r['artist_id'] in dir_ids:
            name = genre_lookup.get(r['genre_id'])
            if name:
                result[r['artist_id']].add(name)
    return dict(result)


def load_mb_tags(client, dir_ids):
    """Return dict: artist_id → set of MB tag strings."""
    rows = client.get('mb_tags', 'artist_id,tag')
    result = defaultdict(set)
    for r in rows:
        if r['artist_id'] in dir_ids:
            result[r['artist_id']].add(r['tag'])
    return dict(result)


def load_mb_collabs(client, dir_ids):
    """Return set of canonical (id_a, id_b) tuples for dir-artist pairs."""
    rows = client.get('mb_collaborations', 'artist_id_a,artist_id_b')
    return {
        pair_key(r['artist_id_a'], r['artist_id_b'])
        for r in rows
        if r['artist_id_a'] in dir_ids and r['artist_id_b'] in dir_ids
    }


def load_sc_follow_edges(client, dir_ids):
    """
    Return:
      direct_edges    — set of (follower_id, followed_id) tuples,
                        restricted to dir-artist→dir-artist edges
      followers_of    — dict: followed_id → set of follower_ids
      following_lists — dict: follower_id → list of followed_ids
    """
    # follower_artist_id is always a directory artist by construction;
    # fetch all rows and filter followed to dir_ids client-side.
    rows = client.get('sc_follow_edges', 'follower_artist_id,followed_artist_id')

    direct_edges    = set()
    followers_of    = defaultdict(set)
    following_lists = defaultdict(list)

    for r in rows:
        follower = r['follower_artist_id']
        followed = r['followed_artist_id']
        if follower not in dir_ids or followed not in dir_ids:
            continue
        direct_edges.add((follower, followed))
        followers_of[followed].add(follower)
        following_lists[follower].append(followed)

    return direct_edges, dict(followers_of), dict(following_lists)


def load_all_signals(client, dir_ids):
    """Load all signal tables and return a dict of data structures."""
    print('  Loading artist genres…')
    genres = load_artist_genres(client, dir_ids)
    print(f'    {sum(len(v) for v in genres.values())} assignments across {len(genres)} artists.')

    print('  Loading MusicBrainz tags…')
    mb_tags = load_mb_tags(client, dir_ids)
    print(f'    {sum(len(v) for v in mb_tags.values())} assignments across {len(mb_tags)} artists.')

    print('  Loading MusicBrainz collaborations…')
    collab_pairs = load_mb_collabs(client, dir_ids)
    print(f'    {len(collab_pairs)} edges.')

    print('  Loading SoundCloud follow edges…')
    direct_edges, followers_of, following_lists = load_sc_follow_edges(client, dir_ids)
    print(f'    {len(direct_edges)} dir→dir edges.')

    return {
        'genres':          genres,
        'mb_tags':         mb_tags,
        'collab_pairs':    collab_pairs,
        'direct_edges':    direct_edges,
        'followers_of':    followers_of,
        'following_lists': following_lists,
    }


# ---------------------------------------------------------------------------
# Pair building and scoring
# ---------------------------------------------------------------------------

SCORE_COLUMNS = [
    'artist_id_a',
    'artist_id_b',
    'genre_score',
    'mb_tag_score',
    'mb_collab_score',
    'sc_direct_follow_score',
    'sc_co_follow_score',
]


# ---------------------------------------------------------------------------
# Signal data cache
# ---------------------------------------------------------------------------

DEFAULT_SIGNALS_CACHE = Path('.cache/signals.json')


def save_signals_cache(dir_ids, id_to_name, signals, path=DEFAULT_SIGNALS_CACHE):
    """
    Serialise all signal data to a JSON file so compute-scores.py can be
    re-run without fetching from the database.

    Sets and tuples are not JSON-serialisable, so they are converted to
    lists here and restored by load_signals_cache().
    """
    data = {
        'dir_ids':        list(dir_ids),
        'id_to_name':     id_to_name,
        'genres':         {k: list(v) for k, v in signals['genres'].items()},
        'mb_tags':        {k: list(v) for k, v in signals['mb_tags'].items()},
        'collab_pairs':   [list(p)    for p in signals['collab_pairs']],
        'direct_edges':   [list(e)    for e in signals['direct_edges']],
        'followers_of':   {k: list(v) for k, v in signals['followers_of'].items()},
        'following_lists': {k: list(v) for k, v in signals['following_lists'].items()},
    }
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data))
    print(f'  Signal cache saved → {path}')


def load_signals_cache(path=DEFAULT_SIGNALS_CACHE):
    """
    Load signal data from a JSON cache file produced by save_signals_cache().
    Returns (dir_ids, id_to_name, signals) in the same form as the DB loaders.
    """
    data       = json.loads(Path(path).read_text())
    dir_ids    = set(data['dir_ids'])
    id_to_name = data['id_to_name']
    signals    = {
        'genres':          {k: set(v)   for k, v in data['genres'].items()},
        'mb_tags':         {k: set(v)   for k, v in data['mb_tags'].items()},
        'collab_pairs':    {tuple(p)    for p in data['collab_pairs']},
        'direct_edges':    {tuple(e)    for e in data['direct_edges']},
        'followers_of':    {k: set(v)   for k, v in data['followers_of'].items()},
        'following_lists': {k: list(v)  for k, v in data['following_lists'].items()},
    }
    return dir_ids, id_to_name, signals


def build_pair_scores(dir_ids, signals):
    """
    Enumerate all pairs of directory artists with at least one signal,
    compute the five raw signal scores for each, and return a list of
    row tuples in SCORE_COLUMNS order.

    Only pairs where at least one signal is non-zero are included.
    """
    genres          = signals['genres']
    mb_tags         = signals['mb_tags']
    collab_pairs    = signals['collab_pairs']
    direct_edges    = signals['direct_edges']
    followers_of    = signals['followers_of']
    following_lists = signals['following_lists']

    # --- Build pair set from all signals ---
    pairs = set()

    def add_pairs_from_index(index):
        for artists in index.values():
            arr = list(artists)
            for i in range(len(arr)):
                for j in range(i + 1, len(arr)):
                    pairs.add(pair_key(arr[i], arr[j]))

    # Genre overlap
    genre_index = defaultdict(list)
    for aid, gs in genres.items():
        for g in gs:
            genre_index[g].append(aid)
    add_pairs_from_index(genre_index)

    # MB tag overlap
    tag_index = defaultdict(list)
    for aid, ts in mb_tags.items():
        for t in ts:
            tag_index[t].append(aid)
    add_pairs_from_index(tag_index)

    # MB collaborations
    pairs.update(collab_pairs)

    # SC direct follows
    for (follower, followed) in direct_edges:
        pairs.add(pair_key(follower, followed))

    # SC co-follow: for each follower, enumerate pairs among who they follow
    co_follow_counts = defaultdict(int)
    for followed_list in following_lists.values():
        arr = followed_list
        for i in range(len(arr)):
            for j in range(i + 1, len(arr)):
                key = pair_key(arr[i], arr[j])
                pairs.add(key)
                co_follow_counts[key] += 1

    # --- Score each pair ---
    rows = []
    for (id_a, id_b) in pairs:
        if id_a not in dir_ids or id_b not in dir_ids:
            continue

        genre_s  = jaccard(genres.get(id_a, set()), genres.get(id_b, set()))
        tag_s    = jaccard(mb_tags.get(id_a, set()), mb_tags.get(id_b, set()))
        collab_s = 1.0 if (id_a, id_b) in collab_pairs else 0.0

        direct_s = 1.0 if (
            (id_a, id_b) in direct_edges or (id_b, id_a) in direct_edges
        ) else 0.0

        co_count = co_follow_counts.get((id_a, id_b), 0)
        fa = len(followers_of.get(id_a, set()))
        fb = len(followers_of.get(id_b, set()))
        co_s = min(co_count / math.sqrt(fa * fb), 1.0) if fa > 0 and fb > 0 else 0.0

        rows.append((id_a, id_b, genre_s, tag_s, collab_s, direct_s, co_s))

    return rows
