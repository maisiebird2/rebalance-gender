-- Migration: api_response_cache table
-- Run this once in the Supabase SQL editor before running the updated
-- scripts/resolve-and-load-links-lf-mb-sp.mjs.
--
-- Why:
--
--   resolve-and-load-links-lf-mb-sp.mjs previously memoized external API
--   responses (Last.fm search/tags, MusicBrainz search, Spotify search) in
--   a local .cache/ directory of JSON files. Per the project rule "write to
--   the database, not cache files", that memoization now lives here instead.
--
--   This stores raw API payloads keyed by (namespace, cache_key) so repeat
--   lookups skip the rate-limited external call. It does NOT track "what has
--   been processed" — that has always been derived from pending_artist_links
--   (see alreadyResolved() in the script).
--
--   There is NO TTL / expiry. Rows are durable: consumers treat any stored
--   payload as a hit regardless of age, and refresh a row only by upserting a
--   new payload over the same (namespace, cache_key). This lets the table
--   double as a permanent harvest store — e.g. sync-discogs.mjs parks the full
--   Discogs artist response here (namespace 'discogs-artist') so fields it
--   doesn't yet extract can be mined later without re-calling the API. Do not
--   add a blanket age-based purge; it would delete those durable payloads.
--
-- Safe to re-run (IF NOT EXISTS / idempotent GRANT).

CREATE TABLE IF NOT EXISTS "public"."api_response_cache" (
  "namespace"  text        NOT NULL,
  "cache_key"  text        NOT NULL,
  "payload"    jsonb       NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("namespace", "cache_key")
);

-- Kept for ad-hoc inspection / ordering by recency. No TTL depends on it.
CREATE INDEX IF NOT EXISTS "api_response_cache_fetched_at_idx"
  ON "public"."api_response_cache" ("fetched_at");

-- Server-side/internal state only. Enable RLS with no policies so anon /
-- authenticated cannot read or write any rows, matching the other
-- service_role-only tables (e.g. resolved_artists, artist_enrichment).
ALTER TABLE "public"."api_response_cache" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."api_response_cache" TO "service_role";

-- NOTE: intentionally NO age-based purge. If you ever need to trim the
-- ephemeral search-cache namespaces (lastfm/mb/spotify), scope the delete by
-- namespace so durable harvest payloads are preserved, e.g.:
--   DELETE FROM "public"."api_response_cache"
--    WHERE "fetched_at" < now() - interval '90 days'
--      AND "namespace" <> 'discogs-artist';
