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
--   This is a pure response cache: it stores raw API payloads keyed by
--   (namespace, cache_key) so repeat lookups skip the rate-limited external
--   call. It does NOT track "what has been processed" — that has always been
--   derived from pending_artist_links (see alreadyResolved() in the script).
--
--   Rows older than the script's CACHE_TTL_DAYS are treated as misses and
--   refetched; the script upserts a fresh payload + fetched_at on write, so
--   stale rows are naturally overwritten rather than accumulating. An
--   optional periodic cleanup is provided at the bottom.
--
-- Safe to re-run (IF NOT EXISTS / idempotent GRANT).

CREATE TABLE IF NOT EXISTS "public"."api_response_cache" (
  "namespace"  text        NOT NULL,
  "cache_key"  text        NOT NULL,
  "payload"    jsonb       NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("namespace", "cache_key")
);

-- Supports the TTL filter (fetched_at >= cutoff) and any age-based cleanup.
CREATE INDEX IF NOT EXISTS "api_response_cache_fetched_at_idx"
  ON "public"."api_response_cache" ("fetched_at");

-- Server-side/internal state only. Enable RLS with no policies so anon /
-- authenticated cannot read or write any rows, matching the other
-- service_role-only tables (e.g. resolved_artists, artist_enrichment).
ALTER TABLE "public"."api_response_cache" ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE "public"."api_response_cache" TO "service_role";

-- Optional: purge entries older than 30 days. Safe to run anytime; the
-- script refetches on miss. Uncomment to run manually or wire to a cron job.
-- DELETE FROM "public"."api_response_cache"
--  WHERE "fetched_at" < now() - interval '30 days';
