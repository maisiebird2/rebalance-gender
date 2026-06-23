"""
MusicBrainz collector.

Two modes:
  search_candidates()  — returns top N raw candidates for a name query,
                         used by resolve_candidates.py for ID resolution.
  get_relations()      — returns artist relations for a known MBID,
                         used by build_graph.py for edge building.

Rate limit: MusicBrainz asks for max 1 req/s.
"""
import time
import logging
import musicbrainzngs
from recommender import cache, config

log = logging.getLogger(__name__)

musicbrainzngs.set_useragent(
    "ArtistRecommender",
    "1.0",
    "https://your-site.com",   # replace with your actual site URL
)

_MIN_INTERVAL = 1.1  # seconds between requests
_last_call: float = 0.0


def _throttle():
    global _last_call
    wait = _MIN_INTERVAL - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


# ── Candidate search (used by resolve_candidates.py) ──────────────────────────

def search_candidates(artist_name: str, limit: int = 5) -> list[dict]:
    """
    Search MusicBrainz for artists matching the name and return raw candidate dicts.

    MusicBrainz returns a relevance score (0–100) from its own text search.
    We include it in api_data for reference but don't use it as our confidence
    score — we run our own scoring instead so it's comparable across services.

    Each candidate:
        {
            "external_id":   str,         # MBID
            "external_name": str,
            "genres":        list[str],   # MusicBrainz tags
            "location":      str | None,  # "City, Country" if available
            "bio":           str | None,  # disambiguation text
            "listeners":     None,        # not available from MusicBrainz
            "api_data":      dict,
        }
    """
    cache_key = f"search:{artist_name}:{limit}"
    cached = cache.get("mb_search", cache_key)
    if cached is not None:
        return cached

    _throttle()
    try:
        result = musicbrainzngs.search_artists(artist=artist_name, limit=limit)
    except musicbrainzngs.WebServiceError as e:
        log.warning("MusicBrainz search failed for %s: %s", artist_name, e)
        return []

    raw_artists = result.get("artist-list", [])
    candidates = []

    for a in raw_artists:
        mbid  = a.get("id", "")
        name  = a.get("name", "") or a.get("sort-name", "")
        disam = a.get("disambiguation", "")   # e.g. "rock band from London"

        # Location: MusicBrainz has begin-area (where formed) and area (current)
        area       = _area_string(a.get("area"))
        begin_area = _area_string(a.get("begin-area"))
        location   = begin_area or area   # prefer begin-area (where they started)

        # Tags (genres)
        tags = [t["name"].lower() for t in a.get("tag-list", [])]

        # MusicBrainz search score (0–100) from their own relevance ranking
        mb_score = int(a.get("ext:score", 0) or 0)

        candidates.append({
            "external_id":   mbid,
            "external_name": name,
            "genres":        tags,
            "location":      location,
            "bio":           disam or None,
            "listeners":     None,
            "api_data": {
                "mbid":           mbid,
                "name":           name,
                "disambiguation": disam,
                "type":           a.get("type"),         # "Person" or "Group"
                "area":           area,
                "begin_area":     begin_area,
                "country":        a.get("country"),
                "tags":           tags,
                "mb_score":       mb_score,
                "life-span":      a.get("life-span"),
            },
        })

    cache.set("mb_search", cache_key, candidates)
    return candidates


def _area_string(area: dict | None) -> str | None:
    """Extract a readable location string from a MusicBrainz area object."""
    if not area:
        return None
    parts = [area.get("name")]
    # Dig into sort-name or iso-3166 codes if present
    return ", ".join(p for p in parts if p) or None


# ── Graph-building helpers (used by build_graph.py) ───────────────────────────

def resolve_mbid(artist_name: str) -> str | None:
    """Resolve to an MBID. Call only for artists whose link is already approved."""
    candidates = search_candidates(artist_name, limit=1)
    return candidates[0]["external_id"] if candidates else None


def get_relations(mbid: str) -> list[dict]:
    """
    Return all artist-to-artist relations for the given MBID.

    Each entry:
        {
            "name":          str,
            "mbid":          str,
            "relation_type": str,
            "score":         float  (from config.MB_RELATION_SCORES)
        }
    """
    cached = cache.get("mb_relations", mbid)
    if cached is not None:
        return cached

    _throttle()
    try:
        result = musicbrainzngs.get_artist_by_id(mbid, includes=["artist-rels"])
    except musicbrainzngs.WebServiceError as e:
        log.warning("MusicBrainz lookup failed for %s: %s", mbid, e)
        return []

    relations = result.get("artist", {}).get("artist-relation-list", [])
    out = []
    for rel in relations:
        rel_type = rel.get("type", "").lower()
        score = config.MB_RELATION_SCORES.get(rel_type)
        if score is None:
            continue
        related = rel.get("artist", {})
        name = related.get("name") or related.get("sort-name")
        related_mbid = related.get("id")
        if name and related_mbid:
            out.append({
                "name":          name,
                "mbid":          related_mbid,
                "relation_type": rel_type,
                "score":         score,
            })

    cache.set("mb_relations", mbid, out)
    return out
