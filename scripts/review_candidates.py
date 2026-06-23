#!/usr/bin/env python3
"""
Step 2 of 2: Review and approve/reject API candidates.

Subcommands:

  export   — Export pending candidates to a CSV file for spreadsheet review.
             Edit the 'status' column (approved/rejected/skipped) and save.
             Then run `import` to load your decisions back.

  import   — Read a reviewed CSV back in and update pending_artist_links.

  promote  — Copy all approved candidates into artist_links so build_graph.py
             can use them.

  stats    — Show a summary of where things stand.

Typical workflow:
    python review_candidates.py export --out candidates.csv
    # open candidates.csv in Excel/Numbers, set status column, save
    python review_candidates.py import --file candidates.csv
    python review_candidates.py promote
    python build_graph.py
"""
import argparse
import csv
import json
import logging
import sys
from datetime import timezone, datetime
import psycopg2
import psycopg2.extras

from recommender import db, config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

VALID_STATUSES = {"best match", "close match", "tie", "pending", "approved", "rejected", "skipped", "loaded"}

# Columns written to / read from the CSV
CSV_FIELDS = [
    "row_id",           # pending_artist_links.id (UUID) — don't change this
    "artist_name",
    "service",
    "rank",
    "external_name",
    "external_id",
    "confidence",
    "score_name",
    "score_genre",
    "score_location",
    "score_bio",
    "status",           # ← edit this column
    "review_note",      # ← optional free-text note
    # Informational only (not imported back):
    "api_genres",
    "api_location",
    "api_bio",
    "api_extra",
]


# ── Export ────────────────────────────────────────────────────────────────────

def cmd_export(conn, args):
    out_path = args.out or "candidates.csv"
    service_filter = f"AND p.service = '{args.service}'" if args.service else ""
    status_filter  = f"AND p.status = '{args.status}'" if args.status else ""

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(f"""
            SELECT
                p.id::text          AS row_id,
                a.name              AS artist_name,
                p.service,
                p.candidate_rank    AS rank,
                p.external_name,
                p.external_id,
                round(p.confidence::numeric, 3)       AS confidence,
                round(p.score_name::numeric, 2)       AS score_name,
                round(p.score_genre::numeric, 2)      AS score_genre,
                round(p.score_location::numeric, 2)   AS score_location,
                round(p.score_bio::numeric, 2)        AS score_bio,
                p.status,
                p.review_note,
                p.api_data
            FROM pending_artist_links p
            JOIN {config.ARTISTS_TABLE} a ON a.{config.ARTISTS_ID_COL} = p.artist_id
            WHERE 1=1
            {service_filter}
            {status_filter}
            ORDER BY a.name, p.service, p.candidate_rank
        """)
        rows = cur.fetchall()

    if not rows:
        log.info("No matching candidates found.")
        return

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            api = row.get("api_data") or {}
            if isinstance(api, str):
                api = json.loads(api)
            writer.writerow({
                **row,
                "api_genres":   ", ".join(api.get("genres", api.get("tags", [])) or []),
                "api_location": api.get("area") or api.get("begin_area") or "",
                "api_bio":      api.get("disambiguation") or "",
                "api_extra":    json.dumps({
                    k: v for k, v in api.items()
                    if k not in {"genres", "tags", "area", "begin_area", "disambiguation"}
                }),
            })

    log.info("Exported %d candidates to %s", len(rows), out_path)
    log.info(
        "Edit the 'status' column: approved / rejected / skipped\n"
        "Then run: python review_candidates.py import --file %s", out_path
    )


# ── Import ─────────────────────────────────────────────────────────────────────

def cmd_import(conn, args):
    if not args.file:
        log.error("--file is required for import")
        sys.exit(1)

    updated = skipped = errors = 0

    with open(args.file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        with conn.cursor() as cur:
            for line_no, row in enumerate(reader, start=2):  # 2 = skip header
                row_id = row.get("row_id", "").strip()
                status = row.get("status", "").strip().lower()
                note   = row.get("review_note", "").strip() or None

                if not row_id:
                    log.warning("Line %d: missing row_id — skipping", line_no)
                    skipped += 1
                    continue

                if status not in VALID_STATUSES:
                    log.warning(
                        "Line %d: invalid status '%s' for row %s — skipping",
                        line_no, status, row_id,
                    )
                    skipped += 1
                    continue

                try:
                    cur.execute("""
                        UPDATE pending_artist_links
                        SET status      = %s,
                            review_note = %s,
                            reviewed_at = now()
                        WHERE id = %s::uuid
                    """, (status, note, row_id))
                    updated += 1
                except Exception as e:
                    log.error("Line %d: error updating %s: %s", line_no, row_id, e)
                    errors += 1

    conn.commit()
    log.info("Import done: %d updated, %d skipped, %d errors", updated, skipped, errors)


# ── Promote ───────────────────────────────────────────────────────────────────

def cmd_promote(conn, args):
    """
    Copy approved candidates into artist_links.
    Only the rank-1 (highest-confidence) approved candidate per artist+service
    is promoted. If the row already exists in artist_links, it is updated.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # Fetch the best approved candidate per artist per service
        cur.execute("""
            SELECT DISTINCT ON (artist_id, service)
                artist_id,
                service,
                external_id,
                external_name,
                confidence
            FROM pending_artist_links
            WHERE status = 'approved'
            ORDER BY artist_id, service, confidence DESC
        """)
        to_promote = cur.fetchall()

    if not to_promote:
        log.info("No approved candidates to promote.")
        return

    promoted = 0
    with conn.cursor() as cur:
        for row in to_promote:
            aid     = row["artist_id"]
            service = row["service"]
            ext_id  = row["external_id"]
            ext_name = row["external_name"]

            if service == "lastfm":
                cur.execute("""
                    INSERT INTO artist_links (artist_id, lastfm_name)
                    VALUES (%s, %s)
                    ON CONFLICT (artist_id) DO UPDATE SET
                        lastfm_name = EXCLUDED.lastfm_name, updated_at = now()
                """, (str(aid), ext_name))

            elif service == "musicbrainz":
                cur.execute("""
                    INSERT INTO artist_links (artist_id, mbid)
                    VALUES (%s, %s)
                    ON CONFLICT (artist_id) DO UPDATE SET
                        mbid = EXCLUDED.mbid, updated_at = now()
                """, (str(aid), ext_id))

            elif service == "spotify":
                cur.execute("""
                    INSERT INTO artist_links (artist_id, spotify_id)
                    VALUES (%s, %s)
                    ON CONFLICT (artist_id) DO UPDATE SET
                        spotify_id = EXCLUDED.spotify_id, updated_at = now()
                """, (str(aid), ext_id))

            promoted += 1

    conn.commit()
    log.info("Promoted %d approved candidates to artist_links.", promoted)
    log.info("You can now run: python build_graph.py")


# ── Stats ─────────────────────────────────────────────────────────────────────

def cmd_stats(conn, args):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT
                service,
                status,
                count(*)                                    AS count,
                round(avg(confidence)::numeric, 3)         AS avg_confidence,
                round(avg(CASE WHEN candidate_rank = 1 THEN confidence END)::numeric, 3)
                                                            AS avg_top1_confidence
            FROM pending_artist_links
            GROUP BY service, status
            ORDER BY service, status
        """)
        rows = cur.fetchall()

    if not rows:
        log.info("pending_artist_links is empty — run resolve_candidates.py first.")
        return

    print(f"\n{'Service':<15} {'Status':<10} {'Count':>6} {'Avg conf':>10} {'Top-1 conf':>12}")
    print("─" * 58)
    for r in rows:
        print(
            f"{r['service']:<15} {r['status']:<10} "
            f"{r['count']:>6} {str(r['avg_confidence'] or '—'):>10} "
            f"{str(r['avg_top1_confidence'] or '—'):>12}"
        )

    # Artists with no approved links yet
    cur = conn.cursor()
    cur.execute(f"""
        SELECT count(*) FROM {config.ARTISTS_TABLE} a
        WHERE NOT EXISTS (
            SELECT 1 FROM artist_links l WHERE l.artist_id = a.{config.ARTISTS_ID_COL}
        )
    """)
    no_links = cur.fetchone()[0]
    print(f"\nArtists with no approved links yet: {no_links}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Review and promote API candidate matches.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_export = sub.add_parser("export", help="Export pending candidates to CSV")
    p_export.add_argument("--out", help="Output CSV path (default: candidates.csv)")
    p_export.add_argument("--service", choices=["lastfm", "musicbrainz", "spotify"])
    p_export.add_argument("--status",
                          choices=["best match", "close match", "tie", "pending",
                                   "approved", "rejected", "skipped", "loaded"],
                          help="Filter by status (default: export all)")

    p_import = sub.add_parser("import", help="Import reviewed CSV back into DB")
    p_import.add_argument("--file", required=True, help="Path to reviewed CSV file")

    sub.add_parser("promote", help="Copy approved candidates to artist_links")
    sub.add_parser("stats",   help="Show review progress summary")

    args = parser.parse_args()

    conn = db.connect()
    try:
        {"export": cmd_export, "import": cmd_import,
         "promote": cmd_promote, "stats": cmd_stats}[args.cmd](conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
