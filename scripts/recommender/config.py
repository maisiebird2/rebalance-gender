"""
Central config — safe to commit to version control.

Secrets (API keys, database URL) are never stored here.
They are read from environment variables, which you supply in one of two ways:

  Local development:
    Copy .env.example to .env, fill in your values.
    python-dotenv loads that file automatically when the scripts run.
    .env is listed in .gitignore and must never be committed.

  GitHub Actions (or any CI/CD):
    Set secrets under repo → Settings → Secrets and variables → Actions.
    The workflow yaml passes them as env vars; no .env file is needed.

This file only contains non-secret configuration (weights, table names,
relation scores). It is safe to commit.
"""
import os
from dotenv import load_dotenv

# load_dotenv() reads .env if it exists, and is silently ignored otherwise.
# In CI/production, environment variables are set directly and .env is absent.
load_dotenv()

def _require(key: str) -> str:
    val = os.getenv(key)
    if not val:
        raise EnvironmentError(f"Missing required env var: {key}")
    return val

# Database
SUPABASE_DB_URL: str = _require("SUPABASE_DB_URL")

# APIs
SPOTIFY_CLIENT_ID: str     = _require("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET: str = _require("SPOTIFY_CLIENT_SECRET")

# Edge weights (must sum to 1.0)
#
# Last.fm was the third signal here, weighted 0.50 against MusicBrainz
# 0.30 and Spotify 0.20. It was removed when Last.fm data was dropped
# from the directory (see supabase_migration_remove_lastfm_data.sql);
# the remaining two were renormalised to keep the sum at 1.0, preserving
# their 3:2 ratio.
WEIGHT_MUSICBRAINZ:   float = float(os.getenv("WEIGHT_MUSICBRAINZ", "0.60"))
WEIGHT_SPOTIFY:       float = float(os.getenv("WEIGHT_SPOTIFY", "0.40"))

# Artists table — core columns
ARTISTS_TABLE:    str = os.getenv("ARTISTS_TABLE", "artists")
ARTISTS_ID_COL:   str = os.getenv("ARTISTS_ID_COL", "id")
ARTISTS_NAME_COL: str = os.getenv("ARTISTS_NAME_COL", "name")

# Note: location is fetched from the artist_locations table (city, country).
#       Bio is fetched from the artist_enrichment table (bio column).
#       Neither requires configuration here.

# How many candidates per service to fetch and score (top N are stored)
CANDIDATES_PER_SERVICE: int = int(os.getenv("CANDIDATES_PER_SERVICE", "5"))

# MusicBrainz relation types and their raw scores (before applying WEIGHT_MUSICBRAINZ)
# Higher = stronger signal that audiences overlap
MB_RELATION_SCORES: dict[str, float] = {
    "collaboration":        1.0,
    "member of band":       0.9,
    "supporting musician":  0.6,
    "tribute":              0.5,
    "has been member of":   0.4,
}
