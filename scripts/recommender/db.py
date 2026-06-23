"""
Database helpers for Supabase (PostgreSQL via psycopg2).

All writes use INSERT … ON CONFLICT … DO UPDATE so the build script is
safely re-runnable — re-running updates existing scores rather than
duplicating rows.
"""
import logging
import psycopg2
import psycopg2.extras
from recommender import config

log = logging.getLogger(__name__)


def connect():
    """Return a psycopg2 connection to Supabase."""
    conn = psycopg2.connect(config.SUPABASE_DB_URL)
    conn.autocommit = False
    return conn


# ── Artist fetching ────────────────────────────────────────────────────────────

def fetch_all_artists(conn) -> list[dict]:
    """
    Return every row from the artists table as {"id": ..., "name": ...}.
    Uses config.ARTISTS_TABLE / ARTISTS_ID_COL / ARTISTS_NAME_COL.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            f'SELECT {config.ARTISTS_ID_COL} AS id, {config.ARTISTS_NAME_COL} AS name '
            f'FROM {config.ARTISTS_TABLE} ORDER BY name'
        )
        return [dict(r) for r in cur.fetchall()]


# ── artist_links ───────────────────────────────────────────────────────────────

def upsert_artist_link(conn, artist_id: str, lastfm_name: str | None,
                       mbid: str | None, spotify_id: str | None) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO artist_links (artist_id, lastfm_name, mbid, spotify_id)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (artist_id) DO UPDATE SET
                lastfm_name  = COALESCE(EXCLUDED.lastfm_name,  artist_links.lastfm_name),
                mbid         = COALESCE(EXCLUDED.mbid,         artist_links.mbid),
                spotify_id   = COALESCE(EXCLUDED.spotify_id,   artist_links.spotify_id),
                updated_at   = now()
        """, (str(artist_id), lastfm_name, mbid, spotify_id))


def fetch_artist_links(conn) -> dict[str, dict]:
    """Return {artist_id -> {lastfm_name, mbid, spotify_id}} for all linked artists."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM artist_links")
        return {str(r["artist_id"]): dict(r) for r in cur.fetchall()}


# ── artist_audio_features ──────────────────────────────────────────────────────

def upsert_audio_features(conn, artist_id: str, features: dict) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO artist_audio_features
                (artist_id, danceability, energy, valence, acousticness,
                 instrumentalness, speechiness, tempo, track_count)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (artist_id) DO UPDATE SET
                danceability     = EXCLUDED.danceability,
                energy           = EXCLUDED.energy,
                valence          = EXCLUDED.valence,
                acousticness     = EXCLUDED.acousticness,
                instrumentalness = EXCLUDED.instrumentalness,
                speechiness      = EXCLUDED.speechiness,
                tempo            = EXCLUDED.tempo,
                track_count      = EXCLUDED.track_count,
                updated_at       = now()
        """, (
            str(artist_id),
            features.get("danceability"),
            features.get("energy"),
            features.get("valence"),
            features.get("acousticness"),
            features.get("instrumentalness"),
            features.get("speechiness"),
            features.get("tempo"),
            features.get("track_count"),
        ))


def fetch_all_audio_features(conn) -> dict[str, dict]:
    """Return {artist_id -> features_dict} for all artists with Spotify data."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM artist_audio_features")
        return {str(r["artist_id"]): dict(r) for r in cur.fetchall()}


# ── artist_recommendations ─────────────────────────────────────────────────────

def upsert_edge(conn, artist_a: str, artist_b: str,
                lastfm_score: float = 0.0,
                musicbrainz_score: float = 0.0,
                spotify_score: float = 0.0) -> None:
    """
    Upsert a single directed edge, recalculating combined weight from components.
    Writes both (a→b) and (b→a) so queries only need to filter on artist_a.
    """
    weight = (
        config.WEIGHT_LASTFM      * lastfm_score
        + config.WEIGHT_MUSICBRAINZ * musicbrainz_score
        + config.WEIGHT_SPOTIFY     * spotify_score
    )

    sql = """
        INSERT INTO artist_recommendations
            (artist_a, artist_b, weight, lastfm_score, musicbrainz_score, spotify_score)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (artist_a, artist_b) DO UPDATE SET
            -- Keep the MAX of each component score across runs so a later
            -- partial re-run doesn't wipe a signal we already collected.
            lastfm_score      = GREATEST(EXCLUDED.lastfm_score,      artist_recommendations.lastfm_score),
            musicbrainz_score = GREATEST(EXCLUDED.musicbrainz_score, artist_recommendations.musicbrainz_score),
            spotify_score     = GREATEST(EXCLUDED.spotify_score,     artist_recommendations.spotify_score),
            weight = (
                {w_lfm} * GREATEST(EXCLUDED.lastfm_score,      artist_recommendations.lastfm_score)
              + {w_mb}  * GREATEST(EXCLUDED.musicbrainz_score, artist_recommendations.musicbrainz_score)
              + {w_sp}  * GREATEST(EXCLUDED.spotify_score,     artist_recommendations.spotify_score)
            ),
            updated_at = now()
    """.format(
        w_lfm=config.WEIGHT_LASTFM,
        w_mb=config.WEIGHT_MUSICBRAINZ,
        w_sp=config.WEIGHT_SPOTIFY,
    )

    args = (str(artist_a), str(artist_b), weight,
            lastfm_score, musicbrainz_score, spotify_score)

    with conn.cursor() as cur:
        cur.execute(sql, args)
        # Write reverse direction with same scores
        cur.execute(sql, (str(artist_b), str(artist_a), weight,
                          lastfm_score, musicbrainz_score, spotify_score))
