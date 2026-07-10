-- Migration: artist_legal_names (private real/legal names)
-- Run once in the Supabase SQL editor before running sync-discogs.mjs
-- (and the HÖR sync, sync-hoer, which also captures a legal name).
--
-- Why:
--
--   Some platforms expose an artist's real/legal name behind their
--   stage name — Discogs `realname`, HÖR `ppma_author.name`. We want
--   to keep those (useful for dedup/disambiguation and admin review)
--   but they must NEVER be public: for a directory of women, femmes,
--   and enbies in electronic music, exposing a legal name risks
--   deadnaming or outing an artist who performs under a chosen name.
--
--   A dedicated one-to-many table (rather than a column on `artists`)
--   keeps this genuinely private with no fragility: the public API
--   roles (anon, authenticated) get NO privileges that can read it,
--   and RLS is on with no SELECT policy — so it is inaccessible via
--   the anon/publishable key regardless. Only service_role (the
--   enrichment scripts, admin) can read or write it. This replaces the
--   earlier plan to add a public-table column `artists.dc_realname`,
--   which would have needed brittle column-level grants.
--
--   One row per (artist_id, platform): each platform contributes at
--   most one current legal name per artist; a later write for the same
--   pair is an upsert, not a new row.
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS, idempotent GRANTs).

CREATE TABLE IF NOT EXISTS "public"."artist_legal_names" (
    "id"          integer NOT NULL,
    "artist_id"   "uuid" NOT NULL,
    "platform"    "text" NOT NULL,
    "legal_name"  "text" NOT NULL,
    "source_url"  "text",
    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"  timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."artist_legal_names" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."artist_legal_names_id_seq"
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE "public"."artist_legal_names_id_seq" OWNER TO "postgres";
ALTER SEQUENCE "public"."artist_legal_names_id_seq" OWNED BY "public"."artist_legal_names"."id";
ALTER TABLE ONLY "public"."artist_legal_names"
    ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_legal_names_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."artist_legal_names"
    ADD CONSTRAINT "artist_legal_names_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."artist_legal_names"
    ADD CONSTRAINT "artist_legal_names_artist_id_platform_key" UNIQUE ("artist_id", "platform");
ALTER TABLE ONLY "public"."artist_legal_names"
    ADD CONSTRAINT "artist_legal_names_artist_id_fkey"
    FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_artist_legal_names_artist_id"
    ON "public"."artist_legal_names" ("artist_id");

-- Keep updated_at current (reuses the existing shared trigger fn).
DROP TRIGGER IF EXISTS "trg_artist_legal_names_updated_at" ON "public"."artist_legal_names";
CREATE TRIGGER "trg_artist_legal_names_updated_at"
    BEFORE UPDATE ON "public"."artist_legal_names"
    FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

-- PRIVATE: RLS on, and NO SELECT policy for anyone. The public roles
-- get only non-reading privileges (matching harvest_failures /
-- collaborations, which are also internal-only). service_role keeps
-- full access for the enrichment scripts and admin.
ALTER TABLE "public"."artist_legal_names" ENABLE ROW LEVEL SECURITY;

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_legal_names" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_legal_names" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_legal_names" TO "service_role";
GRANT USAGE, SELECT ON SEQUENCE "public"."artist_legal_names_id_seq" TO "service_role";
