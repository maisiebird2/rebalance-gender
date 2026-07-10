-- Migration: biographies table (one bio per artist per platform)
-- Run once in the Supabase SQL editor before running sync-discogs.mjs.
--
-- Why:
--
--   Bios have until now lived in artist_enrichment.bio, one row per
--   (artist_id, platform) mixed in with follower/track/image
--   enrichment. As more platforms contribute bios (SoundCloud,
--   Bandcamp, now Discogs), a dedicated one-to-many table is cleaner:
--   each row is a single platform's bio for a single artist, so the
--   site can show, compare, or pick between them.
--
--   sync-discogs.mjs is the first writer (platform = 'discogs'). The
--   existing SoundCloud/Bandcamp bios in artist_enrichment will be
--   backfilled into this table in a later change; this migration only
--   creates the table.
--
--   Raw, unparsed bio text continues to go to artist_harvested_bios
--   (the audit trail); `biographies.bio` holds the cleaned, display-
--   ready text.
--
-- RLS: bios are shown publicly, so this gets an anon-readable SELECT
-- policy scoped to approved artists, matching artist_images /
-- artist_links / artist_enrichment.
--
-- Unique on (artist_id, platform): one current bio per platform per
-- artist; a later write for the same pair is an upsert, not a new row.
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS, idempotent GRANTs/policy).

CREATE TABLE IF NOT EXISTS "public"."biographies" (
    "id"          integer NOT NULL,
    "artist_id"   "uuid" NOT NULL,
    "platform"    "text" NOT NULL,
    "bio"         "text",
    "source_url"  "text",
    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"  timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."biographies" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."biographies_id_seq"
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE "public"."biographies_id_seq" OWNER TO "postgres";
ALTER SEQUENCE "public"."biographies_id_seq" OWNED BY "public"."biographies"."id";
ALTER TABLE ONLY "public"."biographies"
    ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."biographies_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."biographies"
    ADD CONSTRAINT "biographies_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."biographies"
    ADD CONSTRAINT "biographies_artist_id_platform_key" UNIQUE ("artist_id", "platform");
ALTER TABLE ONLY "public"."biographies"
    ADD CONSTRAINT "biographies_artist_id_fkey"
    FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_biographies_artist_id"
    ON "public"."biographies" ("artist_id");

-- Keep updated_at current (reuses the existing shared trigger fn).
DROP TRIGGER IF EXISTS "trg_biographies_updated_at" ON "public"."biographies";
CREATE TRIGGER "trg_biographies_updated_at"
    BEFORE UPDATE ON "public"."biographies"
    FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

ALTER TABLE "public"."biographies" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view bios of approved artists" ON "public"."biographies";
CREATE POLICY "Public can view bios of approved artists" ON "public"."biographies"
    FOR SELECT USING ((EXISTS ( SELECT 1
       FROM "public"."artists" "a"
      WHERE (("a"."id" = "biographies"."artist_id")
        AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."biographies" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."biographies" TO "authenticated";
GRANT ALL ON TABLE "public"."biographies" TO "service_role";
GRANT USAGE, SELECT ON SEQUENCE "public"."biographies_id_seq" TO "service_role";
