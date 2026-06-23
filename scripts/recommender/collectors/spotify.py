"""
Spotify collector.

Two modes:
  search_candidates()      — returns top N raw candidates for a name query,
                             used by resolve_candidates.py for ID resolution.
  get_audio_features()     — returns averaged audio features for a known Spotify ID,
                             used by build_graph.py for edge building.

Uses the Client Credentials flow — no user login needed.
"""
import logging
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from spotipy.cache_handler import MemoryCacheHandler
from recommender import cache, config

log = logging.getLogger(__name__)

FEATURE_KEYS = [
    "danceability", "energy", "valence",
    "acousticness", "instrumentalness", "speechiness", "tempo",
]
TEMPO_MAX = 200.0


def _sp_client() -> spotipy.Spotify:
    """Lazily initialised Spotify client."""
    if not hasattr(_sp_client, "_instance") or _sp_client._instance is None:
        auth = SpotifyClientCredentials(
            client_id=config.SPOTIFY_CLIENT_ID,
            client_secret=config.SPOTIFY_CLIENT_SECRET,
            cache_handler=MemoryCacheHandler(),  # avoids conflict with our .cache/ directory
        )
        _sp_client._instance = spotipy.Spotify(auth_manager=auth)
    return _sp_client._instance


# ── Candidate search (used by resolve_candidates.py) ──────────────────────────

def search_candidates(artist_name: str, limit: int = 5) -> list[dict]:
    """
    Search Spotify for artists matching the name and return raw candidate dicts.

    Spotify returns up to `limit` artists ordered by relevance. We include
    their genres and popularity so our scorer can use them.

    Each candidate:
        {
            "external_id":   str,         # Spotify artist ID
            "external_name": str,
            "genres":        list[str],
            "location":      None,        # Spotify has no location field
            "bio":           None,        # not available via Spotify
            "popularity":    int,         # Spotify popularity 0–100
            "followers":     int,
            "api_data":      dict,
        }
    """
    cache_key = f"search:{artist_name}:{limit}"
    cached = cache.get("spotify_search", cache_key)
    if cached is not None:
        return cached

    try:
        results = _sp_client().search(
            q=f"artist:{artist_name}", type="artist", limit=limit
        )
        items = results.get("artists", {}).get("items", [])
    except Exception as e:
        log.warning("Spotify search failed for %s: %s", artist_name, e)
        return []

    candidates = []
    for a in items:
        candidates.append({
            "external_id":   a["id"],
            "external_name": a["name"],
            "genres":        a.get("genres", []),
            "location":      None,   # not available via Spotify
            "bio":           None,   # not available via Spotify
            "popularity":    a.get("popularity"),
            "followers":     a.get("followers", {}).get("total"),
            "api_data": {
                "spotify_id": a["id"],
                "name":       a["name"],
                "genres":     a.get("genres", []),
                "popularity": a.get("popularity"),
                "followers":  a.get("followers", {}).get("total"),
                "url":        a.get("external_urls", {}).get("spotify"),
                "images":     [img["url"] for img in a.get("images", [])[:1]],
            },
        })

    cache.set("spotify_search", cache_key, candidates)
    return candidates


# ── Graph-building helpers (used by build_graph.py) ───────────────────────────

def resolve_spotify_id(artist_name: str) -> str | None:
    """Resolve to a Spotify ID. Call only for artists whose link is already approved."""
    candidates = search_candidates(artist_name, limit=1)
    return candidates[0]["external_id"] if candidates else None


def get_audio_features(spotify_id: str, market: str = "US") -> dict | None:
    """
    Return averaged audio features for the artist's top tracks.

    Return shape:
        {
            "danceability": float,   "energy": float,
            "valence": float,        "acousticness": float,
            "instrumentalness": float, "speechiness": float,
            "tempo": float,          # normalised 0–1
            "track_count": int,
        }
    """
    cached = cache.get("spotify_features", spotify_id)
    if cached is not None:
        return cached

    try:
        sp = _sp_client()
        top = sp.artist_top_tracks(spotify_id, country=market)
        track_ids = [t["id"] for t in top.get("tracks", [])]
        if not track_ids:
            return None

        features_list = sp.audio_features(track_ids)
        features_list = [f for f in features_list if f]
        if not features_list:
            return None

        n = len(features_list)
        averaged = {k: sum(f[k] for f in features_list) / n for k in FEATURE_KEYS}
        averaged["tempo"] = min(averaged["tempo"] / TEMPO_MAX, 1.0)
        averaged["track_count"] = n

    except Exception as e:
        log.warning("Spotify audio features failed for %s: %s", spotify_id, e)
        return None

    cache.set("spotify_features", spotify_id, averaged)
    return averaged
