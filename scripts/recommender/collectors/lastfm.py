"""
Last.fm collector.

Two modes:
  search_candidates()  — returns top N raw candidates for a name query,
                         used by resolve_candidates.py for ID resolution.
  get_similar()        — returns similar artists for a *known* Last.fm name,
                         used by build_graph.py for edge building.

Rate limit: Last.fm allows ~5 req/s; we use 4 to be safe.
"""
import time
import logging
import requests
from recommender import cache, config

log = logging.getLogger(__name__)

LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/"
_MIN_INTERVAL = 0.25  # seconds between requests (4 req/s)
_last_call: float = 0.0


def _get(params: dict) -> dict:
    """Rate-limited GET to the Last.fm API."""
    global _last_call
    wait = _MIN_INTERVAL - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    params.update({"api_key": config.LASTFM_API_KEY, "format": "json"})
    resp = requests.get(LASTFM_BASE, params=params, timeout=10)
    _last_call = time.monotonic()
    resp.raise_for_status()
    return resp.json()


# ── Candidate search (used by resolve_candidates.py) ──────────────────────────

def search_candidates(artist_name: str, limit: int = 5) -> list[dict]:
    """
    Search Last.fm for artists matching the name and return raw candidate dicts.

    Each candidate:
        {
            "external_id":   str,   # Last.fm uses the canonical name as the identifier
            "external_name": str,
            "genres":        list[str],   # top tags (fetched separately)
            "location":      None,        # Last.fm has no location field
            "bio":           None,        # not fetched at this stage
            "listeners":     int | None,
            "api_data":      dict,        # full raw response for inspection
        }

    Note: Last.fm's "identifier" is the canonical artist name (not a numeric ID).
    We store that as external_id so we can pass it directly to artist.getSimilar.
    """
    cache_key = f"search:{artist_name}:{limit}"
    cached = cache.get("lastfm_search", cache_key)
    if cached is not None:
        return cached

    data = _get({"method": "artist.search", "artist": artist_name, "limit": limit})
    raw_artists = (
        data.get("results", {})
            .get("artistmatches", {})
            .get("artist", [])
    )
    if isinstance(raw_artists, dict):
        raw_artists = [raw_artists]  # Last.fm returns a dict if only 1 result

    candidates = []
    for a in raw_artists:
        name = a.get("name", "")
        listeners = int(a.get("listeners", 0) or 0)

        # Fetch top tags for this artist to use in genre scoring
        tags = _get_top_tags(name)

        candidates.append({
            "external_id":   name,    # Last.fm uses name as the identifier
            "external_name": name,
            "genres":        tags,
            "location":      None,    # not available via Last.fm
            "bio":           None,    # could fetch via artist.getInfo but skipping for speed
            "listeners":     listeners if listeners > 0 else None,
            "api_data":      {
                "name":      name,
                "listeners": listeners,
                "mbid":      a.get("mbid"),
                "url":       a.get("url"),
                "tags":      tags,
            },
        })

    cache.set("lastfm_search", cache_key, candidates)
    return candidates


def _get_top_tags(artist_name: str, limit: int = 10) -> list[str]:
    """Fetch top tags for an artist — used as genre proxy."""
    cache_key = f"tags:{artist_name}"
    cached = cache.get("lastfm_tags", cache_key)
    if cached is not None:
        return cached

    data = _get({
        "method":      "artist.getTopTags",
        "artist":      artist_name,
        "autocorrect": 1,
    })
    if "error" in data:
        cache.set("lastfm_tags", cache_key, [])
        return []

    tags = [t["name"].lower() for t in data.get("toptags", {}).get("tag", [])[:limit]]
    cache.set("lastfm_tags", cache_key, tags)
    return tags


# ── Graph-building helpers (used by build_graph.py) ───────────────────────────

def resolve_name(artist_name: str) -> str | None:
    """
    Resolve to a canonical Last.fm name. Uses the top search result.
    Call this only for artists whose link has already been approved.
    """
    candidates = search_candidates(artist_name, limit=1)
    return candidates[0]["external_name"] if candidates else None


def get_similar(lastfm_name: str, limit: int | None = None) -> list[dict]:
    """
    Return a list of similar artists with similarity scores.
    Each entry: {"name": str, "similarity": float (0–1)}
    """
    limit = limit or config.LASTFM_SIMILAR_LIMIT
    cache_key = f"{lastfm_name}:{limit}"
    cached = cache.get("lastfm_similar", cache_key)
    if cached is not None:
        return cached

    data = _get({
        "method":      "artist.getSimilar",
        "artist":      lastfm_name,
        "limit":       limit,
        "autocorrect": 1,
    })
    if "error" in data:
        log.warning("Last.fm error for %s: %s", lastfm_name, data.get("message"))
        return []

    raw = data.get("similarartists", {}).get("artist", [])
    results = [
        {"name": a["name"], "similarity": float(a["match"])}
        for a in raw
    ]
    cache.set("lastfm_similar", cache_key, results)
    return results
