#!/usr/bin/env python3
"""
Load auto-selected matches into artist_links.

Reads every row in pending_artist_links with status = 'best match' and writes
its URL to artist_links.  resolve_candidates.py is responsible for picking the
winner and setting that status; this script just promotes those decisions.

Usage:
    python load_links.py              # load all best matches
    python load_links.py --dry-run    # preview without writing
    python load_links.py --service lastfm  # one service only
"""
import argparse
import logging
import sys
import psycopg2
import psycopg2.extras

from recommender import db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

ALL_SERVICES = ["lastfm", "musicbrainz", "spotify"]

# Maps our internal service names to the link_platform enum values in artist_links
PLATFORM_MAP = {
    "lastfm":       "lastfm",
    "musicbrainz":  "musicbrainz",
    "spotify":      "spotify",
}


# ── Database helpers ───────────────────────────────────────────────────────────

def fetch_best_matches(conn, services: list[str]) -> list[dict]:
    """Return all rows with status = 'best match' for the given services."""
    placeholders = ", ".join(["%s"] * len(services))
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(f"""
            SELECT
                p.id::text AS row_id,
                p.artist_id::text,
                p.service,
                p.url,
                a.name AS artist_name
            FROM pending_artist_links p
            JOIN artists a ON a.id = p.artist_id
            WHERE p.status = 'best match'
              AND p.service IN ({placeholders})
            ORDER BY a.name, p.service
        """, services)
        return [dict(r) for r in cur.fetchall()]


def upsert_link(conn, artist_id: str, platform: str, url: str) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO artist_links (artist_id, platform, url)
            VALUES (%s::uuid, %s, %s)
            ON CONFLICT (artist_id, platform) DO UPDATE SET
                url = EXCLUDED.url
        """, (artist_id, platform, url))


def mark_loaded(conn, row_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE pending_artist_links
            SET status = 'loaded', reviewed_at = now()
            WHERE id = %s::uuid
        """, (row_id,))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Promote 'best match' candidates from pending_artist_links into artist_links."
    )
    parser.add_argument("--service", choices=ALL_SERVICES,
                        help="Only load one service")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be written without touching the DB")
    args = parser.parse_args()

    services = [args.service] if args.service else ALL_SERVICES

    conn = db.connect()
    try:
        rows = fetch_best_matches(conn, services)

        if not rows:
            log.info("No 'best match' candidates found. "
                     "Run resolve_candidates.py first.")
            return

        log.info("Found %d 'best match' candidate(s) to load.", len(rows))

        loaded = skipped = 0

        for row in rows:
            url = row["url"]
            if not url:
                log.warning("Skipping %r / %s: no URL stored", row["artist_name"], row["service"])
                skipped += 1
                continue

            platform = PLATFORM_MAP[row["service"]]

            if args.dry_run:
                print(f"  {row['artist_name']!r:40} {platform:<15} {url}")
            else:
                upsert_link(conn, row["artist_id"], platform, url)
                mark_loaded(conn, row["row_id"])
                loaded += 1

        if args.dry_run:
            log.info("Dry run — nothing written.")
        else:
            conn.commit()
            log.info("Done. %d link(s) written, %d skipped.", loaded, skipped)

    except Exception as e:
        conn.rollback()
        log.error("Failed: %s", e, exc_info=True)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
