#!/usr/bin/env python3
"""
Find, score, and auto-classify API candidates for each artist.

For each artist, searches Last.fm, MusicBrainz, and Spotify, scores
candidates, then automatically assigns a status to each:

    'best match'  — single winner selected by tie-breaking (load_links.py
                    will load these automatically)
    'close match' — confidence >= CLOSE_MATCH_THRESHOLD (0.95) but not
                    the auto-selected winner; worth a manual look
    'pending'     — everything else

Tie-breaking (applied when multiple candidates share the top confidence):
    1. Exact name match (case-insensitive)
    2. Shortest candidate name
    3. If still tied → all remain 'pending' for manual review

Usage:
    python resolve_candidates.py                   # all artists
    python resolve_candidates.py --artist "Bicep"  # single artist (for testing)
    python resolve_candidates.py --limit 10        # first N artists
    python resolve_candidates.py --service lastfm  # one service only
    python resolve_candidates.py --force           # re-process already-resolved artists
"""
import argparse
import json
import logging
import sys
import urllib.parse
import psycopg2
import psycopg2.extras

from recommender import config, db

# Suppress noisy "uncaught attribute type-id" messages from the MusicBrainz parser
logging.getLogger("musicbrainzngs").setLevel(logging.WARNING)
from recommender import scoring
from recommender.collectors import lastfm, musicbrainz, spotify

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

ALL_SERVICES = ["lastfm", "musicbrainz", "spotify"]

# Candidates at or above this threshold that aren't the auto-selected winner
# are marked 'close match' for optional manual review.
CLOSE_MATCH_THRESHOLD = 0.95


# ── URL construction ──────────────────────────────────────────────────────────

def build_url(service: str, external_id: str, external_name: str) -> str:
    if service == "lastfm":
        return f"https://www.last.fm/music/{urllib.parse.quote(external_name, safe='')}"
    elif service == "musicbrainz":
        return f"https://musicbrainz.org/artist/{external_id}"
    elif service == "spotify":
        return f"https://open.spotify.com/artist/{external_id}"
    raise ValueError(f"Unknown service: {service}")


# ── Tie-breaking and auto-classification ──────────────────────────────────────

def break_tie(our_name: str, candidates: list[dict]) -> dict | None:
    """
    Given multiple candidates that share the top confidence score, pick the best one.

    Step 1 — Exact name match (case-insensitive):
        "33EMYBW" wins over "Slikback & 33EMYBW" and "33emybw feat. Batu".

    Step 2 — Shortest candidate name:
        Fewer words = less likely to be a collaboration or compilation entry.

    Step 3 — Unresolvable: return None (will be logged to artist_link_ties).
    """
    # Step 1: exact name match
    exact = [c for c in candidates
             if c["external_name"].strip().lower() == our_name.strip().lower()]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        candidates = exact  # narrow the field; continue tie-breaking within exact matches

    # Step 2: shortest candidate name
    min_len = min(len(c["external_name"]) for c in candidates)
    shortest = [c for c in candidates if len(c["external_name"]) == min_len]
    if len(shortest) == 1:
        return shortest[0]

    # Step 3: unresolvable
    return None


def assign_statuses(our_name: str, candidates: list[dict]) -> list[dict]:
    """
    Assign a status to each scored candidate:

        'best match'  — single winner selected by tie-breaking
        'close match' — confidence >= CLOSE_MATCH_THRESHOLD but not the winner
        'tie'         — shares the top confidence score and tie-breaking failed;
                        there will always be >= 2 of these when no 'best match' exists
        'pending'     — everything else

    Invariants guaranteed by this function:
        1. At most one candidate is assigned 'best match'.
        2. If any candidate has status 'tie', there are at least two of them
           (they share the unresolvable top confidence score).
    """
    if not candidates:
        return []

    top_conf = candidates[0]["scores"]["confidence"]
    top = [c for c in candidates if c["scores"]["confidence"] == top_conf]

    winner_id = None
    tie_ids: set[str] = set()

    if len(top) == 1:
        winner_id = top[0]["external_id"]
    else:
        winner = break_tie(our_name, top)
        if winner is not None:
            winner_id = winner["external_id"]
        else:
            tie_ids = {c["external_id"] for c in top}

    result = []
    for c in candidates:
        c = dict(c)  # don't mutate the original
        if winner_id and c["external_id"] == winner_id:
            c["status"] = "best match"
        elif c["external_id"] in tie_ids:
            c["status"] = "tie"
        elif c["scores"]["confidence"] >= CLOSE_MATCH_THRESHOLD:
            c["status"] = "close match"
        else:
            c["status"] = "pending"
        result.append(c)

    return result


# ── DB helpers for pending_artist_links ───────────────────────────────────────

def fetch_artists_with_details(conn) -> list[dict]:
    """
    Fetch all artists with their scoring fields.

    - Location: joined from artist_locations (city + country), multiple
      locations concatenated as "City, Country; City, Country".
    - Bio: joined from artist_enrichment (bio column).
    """
    select = ", ".join([
        f"a.{config.ARTISTS_ID_COL} AS id",
        f"a.{config.ARTISTS_NAME_COL} AS name",
    ])

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(f"SELECT {select} FROM {config.ARTISTS_TABLE} a ORDER BY a.name")
        artists = [dict(r) for r in cur.fetchall()]

        # Fetch all locations in one query and index by artist_id
        cur.execute("""
            SELECT artist_id, city, country
            FROM artist_locations
            ORDER BY artist_id
        """)
        locations: dict[str, list[str]] = {}
        for row in cur.fetchall():
            aid = str(row["artist_id"])
            parts = ", ".join(p for p in [row["city"], row["country"]] if p)
            if parts:
                locations.setdefault(aid, []).append(parts)

        # Fetch bios from artist_enrichment
        cur.execute("SELECT artist_id, bio FROM artist_enrichment")
        bios: dict[str, str] = {
            str(row["artist_id"]): row["bio"]
            for row in cur.fetchall()
            if row["bio"]
        }

    for artist in artists:
        aid = str(artist["id"])
        locs = locations.get(aid, [])
        artist["location"] = "; ".join(locs) if locs else None
        artist["bio"] = bios.get(aid)

    return artists


def already_resolved(conn, artist_id: str, service: str) -> bool:
    """Return True if we already have pending or approved candidates for this artist+service."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM pending_artist_links WHERE artist_id = %s AND service = %s LIMIT 1",
            (str(artist_id), service),
        )
        return cur.fetchone() is not None


def fetch_artists_with_spotify_url(conn) -> set[str]:
    """Return the set of artist_ids that already have a Spotify URL in artist_links."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT artist_id::text FROM artist_links WHERE platform = 'spotify'"
        )
        return {row[0] for row in cur.fetchall()}


def upsert_candidates(conn, artist_id: str, service: str, scored_candidates: list[dict]) -> None:
    """
    Write scored candidates to pending_artist_links, ranked by confidence.

    Each candidate must have a 'status' key (added by assign_statuses()).
    On conflict, human review decisions ('approved', 'rejected', 'skipped')
    are always preserved; auto-assigned statuses are overwritten on re-runs.
    """
    with conn.cursor() as cur:
        for rank, c in enumerate(scored_candidates, start=1):
            url = build_url(service, c["external_id"], c["external_name"])
            cur.execute("""
                INSERT INTO pending_artist_links
                    (artist_id, service, candidate_rank,
                     external_id, external_name, url,
                     confidence, score_name, score_genre, score_location,
                     score_bio, score_popularity,
                     api_data, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (artist_id, service, external_id) DO UPDATE SET
                    candidate_rank   = EXCLUDED.candidate_rank,
                    external_name    = EXCLUDED.external_name,
                    url              = EXCLUDED.url,
                    confidence       = EXCLUDED.confidence,
                    score_name       = EXCLUDED.score_name,
                    score_genre      = EXCLUDED.score_genre,
                    score_location   = EXCLUDED.score_location,
                    score_bio        = EXCLUDED.score_bio,
                    score_popularity = EXCLUDED.score_popularity,
                    api_data         = EXCLUDED.api_data,
                    -- Preserve human review decisions; overwrite auto-assigned statuses
                    status = CASE
                        WHEN pending_artist_links.status IN ('approved', 'rejected', 'skipped')
                        THEN pending_artist_links.status
                        ELSE EXCLUDED.status
                    END
            """, (
                str(artist_id), service, rank,
                c["external_id"], c["external_name"], url,
                c["scores"]["confidence"],
                c["scores"]["score_name"],
                c["scores"]["score_genre"],
                c["scores"]["score_location"],
                c["scores"]["score_bio"],
                c["scores"]["score_popularity"],
                json.dumps(c.get("api_data", {})),
                c["status"],
            ))


# ── Per-service resolution ─────────────────────────────────────────────────────

def resolve_lastfm(artist: dict, limit: int) -> list[dict]:
    candidates = lastfm.search_candidates(artist["name"], limit=limit)
    scored = []
    for c in candidates:
        s = scoring.score_candidate(
            our_name=artist["name"],
            our_location=artist.get("location"),
            our_bio=artist.get("bio"),
            candidate_name=c["external_name"],
            candidate_location=c.get("location"),
            candidate_bio=c.get("bio"),
            candidate_listeners=c.get("listeners"),
        )
        scored.append({**c, "scores": s})
    return sorted(scored, key=lambda x: x["scores"]["confidence"], reverse=True)


def resolve_musicbrainz(artist: dict, limit: int) -> list[dict]:
    candidates = musicbrainz.search_candidates(artist["name"], limit=limit)
    scored = []
    for c in candidates:
        s = scoring.score_candidate(
            our_name=artist["name"],
            our_location=artist.get("location"),
            our_bio=artist.get("bio"),
            candidate_name=c["external_name"],
            candidate_location=c.get("location"),
            candidate_bio=c.get("bio"),
        )
        scored.append({**c, "scores": s})
    return sorted(scored, key=lambda x: x["scores"]["confidence"], reverse=True)


def resolve_spotify(artist: dict, limit: int) -> list[dict]:
    candidates = spotify.search_candidates(artist["name"], limit=limit)
    scored = []
    for c in candidates:
        s = scoring.score_candidate(
            our_name=artist["name"],
            our_location=artist.get("location"),
            our_bio=artist.get("bio"),
            candidate_name=c["external_name"],
            candidate_location=c.get("location"),
            candidate_bio=c.get("bio"),
            candidate_popularity=c.get("popularity"),
        )
        scored.append({**c, "scores": s})
    return sorted(scored, key=lambda x: x["scores"]["confidence"], reverse=True)


RESOLVERS = {
    "lastfm":       resolve_lastfm,
    "musicbrainz":  resolve_musicbrainz,
    "spotify":      resolve_spotify,
}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Search APIs for artist matches and write scored candidates to pending_artist_links."
    )
    parser.add_argument("--artist", help="Only process this artist name (useful for spot-checking)")
    parser.add_argument("--limit", type=int, help="Only process the first N artists (useful for test runs)")
    parser.add_argument("--service", choices=ALL_SERVICES, help="Only run one service")
    parser.add_argument(
        "--skip-existing", action="store_true", default=True,
        help="Skip artists that already have pending/approved candidates (default: on)"
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Re-process all artists even if already resolved (overrides --skip-existing)"
    )
    args = parser.parse_args()

    if args.force:
        args.skip_existing = False

    services = [args.service] if args.service else ALL_SERVICES
    limit    = config.CANDIDATES_PER_SERVICE

    log.info("Connecting to Supabase…")
    conn = db.connect()

    try:
        artists = fetch_artists_with_details(conn)
        if args.artist:
            artists = [a for a in artists if a["name"].lower() == args.artist.lower()]
            if not artists:
                log.error("Artist '%s' not found in database.", args.artist)
                sys.exit(1)
        if args.limit:
            artists = artists[:args.limit]

        # Artists that already have a Spotify URL don't need to be searched
        artists_with_spotify = fetch_artists_with_spotify_url(conn)
        if artists_with_spotify:
            log.info("Skipping Spotify search for %d artist(s) that already have a Spotify URL.",
                     sum(1 for a in artists if str(a["id"]) in artists_with_spotify))

        log.info("%d artist(s) to process across service(s): %s", len(artists), ", ".join(services))

        for artist in artists:
            for service in services:
                if service == "spotify" and str(artist["id"]) in artists_with_spotify:
                    continue
                if args.skip_existing and already_resolved(conn, artist["id"], service):
                    continue

                try:
                    scored = RESOLVERS[service](artist, limit)
                    if scored:
                        scored_with_status = assign_statuses(artist["name"], scored)
                        upsert_candidates(conn, artist["id"], service, scored_with_status)
                        ties = [c for c in scored_with_status if c["status"] == "tie"]
                        if ties:
                            log.warning(
                                "Unresolvable tie for %r / %s (conf %.3f)",
                                artist["name"], service,
                                ties[0]["scores"]["confidence"],
                            )
                except Exception as e:
                    log.warning("Failed %s / %s: %s", artist["name"], service, e)

            conn.commit()

    except KeyboardInterrupt:
        log.warning("Interrupted — committing progress so far.")
        conn.commit()
    finally:
        conn.close()

    log.info("Done. Run review_candidates.py to export results for review.")


if __name__ == "__main__":
    main()
