"""
Graph builder.

Orchestrates the three collectors and writes weighted edges to Supabase.

Pass 1 — Resolve IDs
    For each artist in the DB, search Last.fm, MusicBrainz, and Spotify
    to find their canonical IDs. Stored in artist_links.

Pass 2 — Last.fm edges
    For each artist with a Last.fm name, fetch similar artists.
    For each similar artist that is also in our DB (matched by name),
    upsert an edge with the Last.fm similarity as the lastfm_score.

Pass 3 — MusicBrainz edges
    For each artist with an MBID, fetch artist relations.
    For each relation whose target MBID or name matches an artist in our DB,
    upsert an edge with the relation score as the musicbrainz_score.

Pass 4 — Spotify audio similarity
    For each artist with a Spotify ID, fetch + store audio features.
    Then compute pairwise cosine similarity between all artists already
    connected by edges (to keep the matrix sparse), and update spotify_score.
"""
import logging
import numpy as np
from itertools import combinations
from tqdm import tqdm

from recommender import db, config
from recommender.collectors import lastfm, musicbrainz, spotify

log = logging.getLogger(__name__)

FEATURE_KEYS = ["danceability", "energy", "valence",
                "acousticness", "instrumentalness", "speechiness", "tempo"]


def _cosine(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(np.dot(va, vb) / denom) if denom else 0.0


def _feature_vec(features: dict) -> list[float]:
    return [features.get(k, 0.0) for k in FEATURE_KEYS]


def build(conn) -> None:
    """Run all four passes and commit to the database."""

    artists = db.fetch_all_artists(conn)
    log.info("Found %d artists in DB.", len(artists))

    # Index by id and by lowercase name for fast lookup
    by_id:   dict[str, dict] = {str(a["id"]): a for a in artists}
    by_name: dict[str, dict] = {a["name"].lower(): a for a in artists}

    # ── Pass 1: Resolve IDs ────────────────────────────────────────────────
    log.info("Pass 1/4: Resolving API identifiers…")
    existing_links = db.fetch_artist_links(conn)

    for artist in tqdm(artists, desc="Resolving IDs"):
        aid = str(artist["id"])
        name = artist["name"]

        link = existing_links.get(aid, {})
        lfm_name   = link.get("lastfm_name")
        mbid       = link.get("mbid")
        spotify_id = link.get("spotify_id")

        changed = False

        if not lfm_name:
            lfm_name = lastfm.resolve_name(name)
            changed = True

        if not mbid:
            mbid = musicbrainz.resolve_mbid(name)
            changed = True

        if not spotify_id:
            spotify_id = spotify.resolve_spotify_id(name)
            changed = True

        if changed:
            db.upsert_artist_link(conn, aid, lfm_name, mbid, spotify_id)

    conn.commit()
    links = db.fetch_artist_links(conn)

    # Build reverse-lookup indexes from external IDs → our artist ID
    mbid_to_id:   dict[str, str] = {v["mbid"]:       k for k, v in links.items() if v.get("mbid")}
    lfmname_to_id: dict[str, str] = {v["lastfm_name"].lower(): k
                                     for k, v in links.items() if v.get("lastfm_name")}

    # ── Pass 2: Last.fm edges ──────────────────────────────────────────────
    log.info("Pass 2/4: Fetching Last.fm similar-artist edges…")
    edge_count = 0

    for artist_id, link in tqdm(links.items(), desc="Last.fm"):
        lfm_name = link.get("lastfm_name")
        if not lfm_name:
            continue

        similar = lastfm.get_similar(lfm_name)
        for s in similar:
            # Match the similar artist back to one in our DB
            target_id = lfmname_to_id.get(s["name"].lower())
            if not target_id or target_id == artist_id:
                continue
            db.upsert_edge(conn, artist_id, target_id, lastfm_score=s["similarity"])
            edge_count += 1

    conn.commit()
    log.info("Last.fm: wrote %d edges.", edge_count)

    # ── Pass 3: MusicBrainz edges ──────────────────────────────────────────
    log.info("Pass 3/4: Fetching MusicBrainz relation edges…")
    mb_count = 0

    for artist_id, link in tqdm(links.items(), desc="MusicBrainz"):
        mbid = link.get("mbid")
        if not mbid:
            continue

        relations = musicbrainz.get_relations(mbid)
        for rel in relations:
            # Try matching by MBID first, then by name
            target_id = (
                mbid_to_id.get(rel["mbid"])
                or by_name.get(rel["name"].lower(), {}).get("id")
            )
            if not target_id:
                continue
            target_id = str(target_id)
            if target_id == artist_id:
                continue
            db.upsert_edge(conn, artist_id, target_id, musicbrainz_score=rel["score"])
            mb_count += 1

    conn.commit()
    log.info("MusicBrainz: wrote %d edges.", mb_count)

    # ── Pass 4: Spotify audio similarity ──────────────────────────────────
    log.info("Pass 4/4: Computing Spotify audio similarity…")

    for artist_id, link in tqdm(links.items(), desc="Spotify features"):
        spotify_id = link.get("spotify_id")
        if not spotify_id:
            continue
        features = spotify.get_audio_features(spotify_id)
        if features:
            db.upsert_audio_features(conn, artist_id, features)

    conn.commit()

    all_features = db.fetch_all_audio_features(conn)
    artists_with_features = [(aid, f) for aid, f in all_features.items() if aid in by_id]

    # Only compute pairwise similarity for artists already sharing an edge,
    # to keep the matrix sparse. Build a set of existing edge pairs first.
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT artist_a, artist_b FROM artist_recommendations")
        existing_pairs = {(str(r[0]), str(r[1])) for r in cur.fetchall()}

    sp_count = 0
    feature_index = {aid: _feature_vec(f) for aid, f in artists_with_features}

    for (a_id, b_id) in tqdm(existing_pairs, desc="Spotify similarity"):
        if a_id not in feature_index or b_id not in feature_index:
            continue
        sim = _cosine(feature_index[a_id], feature_index[b_id])
        db.upsert_edge(conn, a_id, b_id, spotify_score=sim)
        sp_count += 1

    conn.commit()
    log.info("Spotify: updated %d edges with audio similarity.", sp_count)
    log.info("Graph build complete.")
