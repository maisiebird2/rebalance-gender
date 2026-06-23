#!/usr/bin/env python3
"""
Query the recommendation graph.

Usage:
    python recommend.py "Radiohead"
    python recommend.py "Radiohead" --limit 20
    python recommend.py "Radiohead" --explain      # show per-source scores

Also importable for use in your web backend:
    from recommend import get_recommendations
    results = get_recommendations(conn, artist_id="<uuid>", limit=10)
"""
import argparse
import sys
import psycopg2.extras
from recommender import db, config


def get_recommendations(conn, *, artist_id: str | None = None,
                        artist_name: str | None = None,
                        limit: int = 10) -> list[dict]:
    """
    Return top `limit` recommended artists for the given artist.

    Accepts either artist_id (UUID from your artists table) or artist_name.
    Each result dict:
        {
            "id":               str,
            "name":             str,
            "weight":           float,   # combined score 0–1
            "lastfm_score":     float,
            "musicbrainz_score": float,
            "spotify_score":    float,
        }
    """
    if not artist_id and not artist_name:
        raise ValueError("Provide either artist_id or artist_name.")

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if artist_id is None:
            # Resolve name → id
            cur.execute(
                f"SELECT {config.ARTISTS_ID_COL} FROM {config.ARTISTS_TABLE} "
                f"WHERE lower({config.ARTISTS_NAME_COL}) = lower(%s) LIMIT 1",
                (artist_name,),
            )
            row = cur.fetchone()
            if not row:
                return []
            artist_id = str(row[config.ARTISTS_ID_COL])

        cur.execute("""
            SELECT
                a.id::text        AS id,
                a.name            AS name,
                r.weight,
                r.lastfm_score,
                r.musicbrainz_score,
                r.spotify_score
            FROM artist_recommendations r
            JOIN artists a ON a.id = r.artist_b
            WHERE r.artist_a = %s::uuid
            ORDER BY r.weight DESC
            LIMIT %s
        """.replace("artists", config.ARTISTS_TABLE), (artist_id, limit))

        return [dict(row) for row in cur.fetchall()]


def main():
    parser = argparse.ArgumentParser(description="Query artist recommendations.")
    parser.add_argument("artist", help="Artist name to look up")
    parser.add_argument("--limit", type=int, default=10,
                        help="Number of recommendations (default: 10)")
    parser.add_argument("--explain", action="store_true",
                        help="Show per-source score breakdown")
    args = parser.parse_args()

    conn = db.connect()
    try:
        results = get_recommendations(conn, artist_name=args.artist, limit=args.limit)
    finally:
        conn.close()

    if not results:
        print(f"No recommendations found for '{args.artist}'.")
        print("(Either the artist isn't in the DB, or the graph hasn't been built yet.)")
        sys.exit(1)

    print(f"\nRecommendations for: {args.artist}\n{'─' * 50}")
    for i, r in enumerate(results, 1):
        line = f"{i:>2}. {r['name']:<35} score={r['weight']:.3f}"
        if args.explain:
            line += (
                f"  [lfm={r['lastfm_score']:.2f}"
                f" mb={r['musicbrainz_score']:.2f}"
                f" sp={r['spotify_score']:.2f}]"
            )
        print(line)


if __name__ == "__main__":
    main()
