"""
Confidence scoring for API candidate matches.

Each scorer takes our artist's known data and a candidate dict from an API,
and returns a float 0–1. A value of None means "signal not available"
(e.g. no location in DB, or the API doesn't expose that field).

The combined confidence score is the weighted average of available signals:

    Signal          Weight    Notes
    ──────────────────────────────────────────────────────────────
    name            0.67      Always available; highest weight
    location        0.20      Available if artist has locations and service has area
    bio             0.09      Available if we have a bio and service has description
    popularity      0.04      Plausibility check only; low weight

Weights are renormalised when a signal is absent so they always sum to 1.
"""
import re
import logging
from rapidfuzz import fuzz

log = logging.getLogger(__name__)

# Signal weights — must sum to 1.0
WEIGHTS = {
    "name":       0.67,
    "location":   0.20,
    "bio":        0.09,
    "popularity": 0.04,
}

# Words to strip before location comparison
_LOCATION_STOPWORDS = {
    "the", "of", "and", "in", "at", "city", "town", "village",
    "county", "state", "province", "region", "district",
}

# Articles and prepositions that don't count as meaningful name tokens.
# "The Black Keys" and "Black Keys" should still score 1.0 against each other.
_NAME_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "in", "at",
    "de", "la", "el", "les", "los", "das", "die", "der",
}


def _name_tokens(text: str) -> set[str]:
    """Lowercase, strip punctuation, remove common articles."""
    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    return {t for t in cleaned.split() if t and t not in _NAME_STOPWORDS}


# ── Individual signal scorers ──────────────────────────────────────────────────

def score_name(our_name: str, candidate_name: str) -> float:
    """
    Combines two signals:

    1. token_set_ratio — fuzzy similarity that handles word order differences
       and minor spelling variants. "The Black Keys" vs "Black Keys" → 1.0.

    2. Token coverage (F1) — penalises matches where one name is just a
       substring of a longer one. "1111" would otherwise score 1.0 against
       "Quarteto 1111" because token_set_ratio finds "1111" as a perfect
       subset match. Coverage requires both names to explain each other:
         our_coverage  = what fraction of our tokens appear in the candidate
         cand_coverage = what fraction of candidate tokens appear in ours
         F1            = harmonic mean of both

    Final score = token_set_ratio × F1_coverage.

    Examples:
        "1111"        vs "Quarteto 1111"  → ~0.67  (was 1.0)
        "Black Keys"  vs "The Black Keys" → 1.0    (unchanged)
        "Radiohead"   vs "Radiohead"      → 1.0    (unchanged)
    """
    if not our_name or not candidate_name:
        return 0.0

    tsr = fuzz.token_set_ratio(our_name.lower(), candidate_name.lower()) / 100.0

    our_tokens  = _name_tokens(our_name)  or {our_name.lower()}
    cand_tokens = _name_tokens(candidate_name) or {candidate_name.lower()}

    matched   = len(our_tokens & cand_tokens)
    our_cov   = matched / len(our_tokens)
    cand_cov  = matched / len(cand_tokens)

    if our_cov + cand_cov > 0:
        coverage = 2 * our_cov * cand_cov / (our_cov + cand_cov)
    else:
        coverage = 0.0

    return tsr * coverage


def score_location(our_location: str | None, candidate_location: str | None) -> float | None:
    """
    Token overlap between our location string and the candidate's location.

    Works on city, region, and country tokens independently so
    "London, UK" still scores well against "London, England, United Kingdom".
    Returns None if either location is empty.
    """
    if not our_location or not candidate_location:
        return None

    def tokenise(loc: str) -> set[str]:
        # Split on comma, slash, whitespace; lower; remove stopwords
        tokens = set(re.split(r"[,/\s]+", loc.lower()))
        return tokens - _LOCATION_STOPWORDS - {""}

    ours = tokenise(our_location)
    theirs = tokenise(candidate_location)
    if not ours or not theirs:
        return None

    # Use overlap coefficient (size of intersection / size of smaller set)
    # so a city match scores high even if one side has more detail than the other
    overlap = len(ours & theirs) / min(len(ours), len(theirs))
    return min(overlap, 1.0)


def score_bio(our_bio: str | None, candidate_bio: str | None) -> float | None:
    """
    Light keyword overlap between our bio and the candidate's description /
    disambiguation text.

    Mainly useful for MusicBrainz disambiguation strings like
    "rock band from Manchester" which will strongly match a bio mentioning
    Manchester and rock.

    Returns None if either text is empty.
    """
    if not our_bio or not candidate_bio:
        return None

    # Keep only meaningful words (length ≥ 4, not digits-only)
    def keywords(text: str) -> set[str]:
        words = re.findall(r"\b[a-z]{4,}\b", text.lower())
        stopwords = {
            "that", "this", "with", "from", "have", "been", "their",
            "they", "were", "also", "some", "more", "when", "which",
            "band", "artist", "music", "song", "album", "known",
        }
        return set(words) - stopwords

    ours = keywords(our_bio)
    theirs = keywords(candidate_bio)
    if not ours or not theirs:
        return None

    # Fraction of *our* keywords that appear in the candidate bio
    # (asymmetric: we care about our terms appearing in theirs, not vice-versa)
    hits = sum(1 for w in ours if w in theirs)
    return min(hits / len(ours), 1.0)


def score_popularity(
    our_bio: str | None,
    candidate_popularity: int | None,   # Spotify: 0–100
    candidate_listeners: int | None,    # Last.fm: integer listener count
) -> float | None:
    """
    Plausibility check: does the candidate's popularity level match what we'd
    expect for an artist on this site?

    If the candidate has extremely high popularity (Spotify > 80, or Last.fm
    > 5M listeners) they're almost certainly a mainstream act. If our artist
    bio is short / sparse, that's a weak signal they might be less mainstream.
    This score is low-weight (0.04) and mainly here to break ties.

    Returns None if no popularity data is available.
    """
    score = None

    if candidate_popularity is not None:          # Spotify 0–100
        bio_len = len(our_bio or "")
        if candidate_popularity >= 80 and bio_len < 100:
            score = 0.5   # probably too famous to be a match
        else:
            score = 1.0 - max(0.0, (candidate_popularity - 70) / 100)
            score = max(score, 0.3)

    if candidate_listeners is not None:           # Last.fm integer
        lfm_score = 1.0
        if candidate_listeners > 5_000_000:
            lfm_score = 0.5
        elif candidate_listeners > 1_000_000:
            lfm_score = 0.75
        score = min(score or 1.0, lfm_score)

    return score


# ── Combined scorer ────────────────────────────────────────────────────────────

def combine(scores: dict[str, float | None]) -> float:
    """
    Weighted average of available signals.
    Signals with a None value are excluded and remaining weights renormalised.

    scores: dict keyed by signal name (must be in WEIGHTS).
    Returns combined confidence 0–1.
    """
    total_weight = 0.0
    weighted_sum = 0.0
    for signal, value in scores.items():
        if value is None:
            continue
        w = WEIGHTS.get(signal, 0.0)
        weighted_sum += w * value
        total_weight += w
    return (weighted_sum / total_weight) if total_weight > 0 else 0.0


def score_candidate(
    *,
    our_name: str,
    our_location: str | None,
    our_bio: str | None,
    candidate_name: str,
    candidate_location: str | None,
    candidate_bio: str | None,
    candidate_popularity: int | None = None,
    candidate_listeners: int | None = None,
) -> dict:
    """
    Score a single API candidate against our artist's known data.

    Returns a dict with individual signal scores and the combined confidence:
        {
            "confidence":       float,
            "score_name":       float,
            "score_location":   float | None,
            "score_bio":        float | None,
            "score_popularity": float | None,
        }
    """
    s_name     = score_name(our_name, candidate_name)
    s_location = score_location(our_location, candidate_location)
    s_bio      = score_bio(our_bio, candidate_bio)
    s_pop      = score_popularity(our_bio, candidate_popularity, candidate_listeners)

    scores = {
        "name":       s_name,
        "location":   s_location,
        "bio":        s_bio,
        "popularity": s_pop,
    }
    confidence = combine(scores)

    return {
        "confidence":       confidence,
        "score_name":       s_name,
        "score_genre":      None,   # kept for DB column compatibility
        "score_location":   s_location,
        "score_bio":        s_bio,
        "score_popularity": s_pop,
    }
