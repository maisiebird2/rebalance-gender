-- Migration: harvest_failures table
-- Run once in the Supabase SQL editor before running the merged
-- scripts/sync-soundcloud.mjs (and any future Phase 2 harvester that
-- adopts this pattern).
--
-- Why:
--
--   Today a fetch/resolve failure in a Phase 2 script exists only as a
--   console line and an in-memory tally — once the terminal scrolls,
--   the information is gone. The only durable trace was indirect: a
--   transient failure leaves no resolved_artists row (so it retries
--   next run), and a definitive 404 marks the artist processed without
--   recording *why*. See scripts/PIPELINE.md, "Persist harvest
--   failures as queryable data" (found via a real case: an artist
--   whose soundcloud link field held a Spotify URL failed /resolve,
--   was 404-marked processed, and left no record of the underlying
--   bad link).
--
-- What this is:
--
--   One row per (artist_id, service), holding the *current* failure
--   for that pair — not an accumulating log. A later success clears
--   the row (see clearFailure() in scripts/lib/harvest-failures.mjs),
--   so the table always reflects what's actually still broken and is
--   safe to query directly for review (e.g. "show me every current
--   soundcloud-sync failure").
--
--   status is a short machine-readable code (e.g. 'wrong_field_url',
--   'resolve_404', 'resolve_failed', 'write_failed'); detail is a
--   free-text human-readable reason; url is the offending URL where
--   relevant (e.g. the wrong-platform link that tripped the guard).
--
-- Deliberately separate from resolved_artists rather than adding
-- status/detail columns there: resolved_artists is a simple
-- (artist_id, service) skip-set consumed by every stage's "is this
-- artist already done" check, and every one of those checks would
-- otherwise need to start filtering on a status column. Keeping
-- failures in their own table leaves that skip-set logic untouched
-- and gives every Phase 2 harvester (SoundCloud now, Discogs/Linktree/
-- Bandcamp later) one shared place to log why something failed.
--
-- Grants are included in this same migration (unlike resolved_artists,
-- which was created via the Supabase dashboard without them and had
-- to be patched afterward in supabase_migration_resolved_artists_grants.sql —
-- see that file for the story). RLS is enabled with no policy, same
-- as resolved_artists / artist_harvested_links / artist_harvested_bios:
-- this is server-side/internal state only, not exposed to anon/
-- authenticated.
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS, idempotent GRANTs).

CREATE TABLE IF NOT EXISTS "public"."harvest_failures" (
    "artist_id"   "uuid" NOT NULL,
    "service"     "text" NOT NULL,
    "status"      "text" NOT NULL,
    "detail"      "text",
    "url"         "text",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."harvest_failures" OWNER TO "postgres";

ALTER TABLE ONLY "public"."harvest_failures"
    ADD CONSTRAINT "harvest_failures_pkey" PRIMARY KEY ("artist_id", "service");

ALTER TABLE ONLY "public"."harvest_failures"
    ADD CONSTRAINT "harvest_failures_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;

-- Lets qc/review queries pull "every current failure for this service"
-- without a seq scan.
CREATE INDEX IF NOT EXISTS "idx_harvest_failures_service" ON "public"."harvest_failures" ("service");

ALTER TABLE "public"."harvest_failures" ENABLE ROW LEVEL SECURITY;

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."harvest_failures" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."harvest_failures" TO "authenticated";
GRANT ALL ON TABLE "public"."harvest_failures" TO "service_role";
