-- Migration: artist_images table
-- Run once in the Supabase SQL editor before running the updated
-- scripts/enrich-images.ts. sync-soundcloud.mjs and sync-bandcamp.mjs
-- will move onto this table too in a later change; for now they keep
-- writing to artist_enrichment.profile_image_url as before.
--
-- Why:
--
--   Until now an artist has had exactly one image slot
--   (artists.profile_image_url, fed from whichever platform won
--   PLATFORM_PRIORITY that run) plus one row per platform in
--   artist_enrichment.profile_image_url — a column artist_enrichment
--   was never really meant to own (that table is bio/track/follower
--   enrichment; images were squatting in it). This table is a step
--   toward replacing both: one row per (artist_id, platform) that
--   actually found a usable profile photo, so an artist with images
--   on multiple platforms can keep all of them instead of one
--   platform's pick silently overwriting another's.
--
--   source_url is the original external URL the image was fetched
--   from (og:image, API avatar field, etc.) — kept for re-fetching
--   and provenance. storage_url / storage_path are filled in later,
--   once a re-hosting step (a future update to store-images.mjs)
--   copies the image into Supabase Storage — until then a row can
--   exist with source_url set and storage_url still null.
--
--   Images are only ever stored for directory artists
--   (artists.directory_status = 'approved') — there are roughly 100x
--   as many non-directory artists (follow-graph nodes, etc.) as
--   directory ones, and there's no reason to store images for
--   artists that aren't shown anywhere. That's enforced by each
--   writer (see scripts/enrich-images.ts), not by a CHECK/trigger
--   here — directory_status is mutable and a constraint tying to it
--   would be more machinery than the one-line guard each writer
--   already needs regardless.
--
-- Unique on (artist_id, platform): each platform contributes at most
-- one current image per artist. A later write for the same pair is
-- an upsert (onConflict: "artist_id,platform"), not a new row — like
-- harvest_failures, this table holds the *current* state per key, not
-- a historical log.
--
-- Deliberately keyed differently than harvest_failures even though
-- the shape looks similar: harvest_failures' "service" means "which
-- harvester produced this failure" (soundcloud-sync, bandcamp-sync,
-- image-enrich:<platform>, ...); here "platform" means "which
-- external platform the photo came from". enrich-images.ts is a
-- single harvester that can produce many platform rows per artist, so
-- its harvest_failures rows use a composite service value
-- ("image-enrich:<platform>") to stay per-platform there too, without
-- needing a matching schema change on harvest_failures itself.
--
-- RLS: unlike harvest_failures/resolved_artists (internal-only
-- state), these rows ARE shown publicly — the frontend will read
-- storage_url (or source_url, until re-hosting exists) directly for
-- the artist page, cards, and recommended widget. So this gets a real
-- anon-readable SELECT policy, scoped to approved artists only,
-- matching artist_links'/artist_enrichment's existing "Public can
-- view X of approved artists" policies.
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS, idempotent GRANTs).

CREATE TABLE IF NOT EXISTS "public"."artist_images" (
    "artist_id"    "uuid" NOT NULL,
    "platform"     "text" NOT NULL,
    "source_url"   "text" NOT NULL,
    "storage_url"  "text",
    "storage_path" "text",
    "fetched_at"   timestamp with time zone DEFAULT "now"() NOT NULL,
    "stored_at"    timestamp with time zone
);

ALTER TABLE "public"."artist_images" OWNER TO "postgres";

ALTER TABLE ONLY "public"."artist_images"
    ADD CONSTRAINT "artist_images_pkey" PRIMARY KEY ("artist_id", "platform");

ALTER TABLE ONLY "public"."artist_images"
    ADD CONSTRAINT "artist_images_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;

-- Lets a platform-removal cleanup ("purge everything we ever stored
-- from platform X", e.g. if a platform objects to being scraped)
-- filter without a seq scan.
CREATE INDEX IF NOT EXISTS "idx_artist_images_platform" ON "public"."artist_images" ("platform");

ALTER TABLE "public"."artist_images" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can view images of approved artists" ON "public"."artist_images" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_images"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_images" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_images" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_images" TO "service_role";
