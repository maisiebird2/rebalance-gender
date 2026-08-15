-- Migration: artist_types (producer / DJ / vocalist, one-to-many)
-- Run once in the Supabase SQL editor.
--
-- Why:
--
--   Artists play different roles — one person can be a producer, a DJ,
--   and a vocalist at once — so this is a one-to-many categorisation,
--   modelled exactly like the genres system (a `genres` lookup + an
--   `artist_genres` junction). `artist_types` is the small, curated,
--   closed vocabulary; `artist_type_assignments` is the junction that
--   attaches zero-or-more types to each artist.
--
--   Unlike genres (an open, harvested vocabulary with a
--   pending/approved moderation status), the type vocabulary is fixed
--   and hand-seeded here, so it carries no status column — just a
--   display `label` (so `dj` renders as `DJ`) and a `sort_order` for
--   stable UI ordering.
--
--   Provenance: each assignment records the `source` that claimed it
--   ('manual' for form/existing entries; a platform key such as
--   'discogs' or 'musicbrainz' once harvesters exist) and the
--   `created_at` time it was written. Crucially, the junction's primary
--   key is (artist_id, type_id, source): each source gets its OWN row
--   for the same artist+type. That is the lesson `collaborations`
--   learned the hard way — it lets us later wipe one bad harvester's
--   contributions with a single `DELETE ... WHERE source = '<site>'`
--   without disturbing manual entries or any other source's claims. The
--   UI dedupes the (possibly multi-source) rows down to one pill per
--   type on display.
--
--   The junction is public-readable ONLY for approved artists (mirrors
--   the artist_genres RLS policy); the lookup is fully public. Writes
--   stay with service_role / admin, as with genres.
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS, guarded seeds, idempotent
-- GRANTs and policy drops).

-- ── 1. Lookup: the closed type vocabulary ────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."artist_types" (
    "id"          integer NOT NULL,
    "name"        "text" NOT NULL,
    "label"       "text" NOT NULL,
    "sort_order"  integer DEFAULT 0 NOT NULL
);

ALTER TABLE "public"."artist_types" OWNER TO "postgres";

CREATE SEQUENCE IF NOT EXISTS "public"."artist_types_id_seq"
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE "public"."artist_types_id_seq" OWNER TO "postgres";
ALTER SEQUENCE "public"."artist_types_id_seq" OWNED BY "public"."artist_types"."id";
ALTER TABLE ONLY "public"."artist_types"
    ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_types_id_seq"'::"regclass");

ALTER TABLE ONLY "public"."artist_types"
    ADD CONSTRAINT "artist_types_pkey" PRIMARY KEY ("id");
ALTER TABLE ONLY "public"."artist_types"
    ADD CONSTRAINT "artist_types_name_key" UNIQUE ("name");

-- Seed the initial vocabulary. `name` is the canonical slug (lowercase),
-- `label` is the display form. ON CONFLICT DO NOTHING keeps re-runs safe
-- and leaves any later hand-edits to labels/order untouched.
INSERT INTO "public"."artist_types" ("name", "label", "sort_order") VALUES
    ('producer', 'producer', 1),
    ('dj',       'DJ',       2),
    ('vocalist', 'vocalist', 3)
ON CONFLICT ("name") DO NOTHING;

-- ── 2. Junction: zero-or-more types per artist, one row per source ───────────

CREATE TABLE IF NOT EXISTS "public"."artist_type_assignments" (
    "artist_id"   "uuid" NOT NULL,
    "type_id"     integer NOT NULL,
    "source"      "text" DEFAULT 'manual' NOT NULL,
    "created_at"  timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."artist_type_assignments" OWNER TO "postgres";

-- PK is (artist_id, type_id, source): the same artist+type from two
-- different sources is two rows, so a per-source purge is a clean delete.
ALTER TABLE ONLY "public"."artist_type_assignments"
    ADD CONSTRAINT "artist_type_assignments_pkey"
    PRIMARY KEY ("artist_id", "type_id", "source");

ALTER TABLE ONLY "public"."artist_type_assignments"
    ADD CONSTRAINT "artist_type_assignments_artist_id_fkey"
    FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;
ALTER TABLE ONLY "public"."artist_type_assignments"
    ADD CONSTRAINT "artist_type_assignments_type_id_fkey"
    FOREIGN KEY ("type_id") REFERENCES "public"."artist_types"("id") ON DELETE CASCADE;

-- "All DJs" / per-type lookups shouldn't seq-scan the junction.
CREATE INDEX IF NOT EXISTS "idx_artist_type_assignments_type_id"
    ON "public"."artist_type_assignments" ("type_id");
-- Per-source purge ("wipe this harvester") shouldn't seq-scan either.
CREATE INDEX IF NOT EXISTS "idx_artist_type_assignments_source"
    ON "public"."artist_type_assignments" ("source");

-- ── 3. RLS + grants ──────────────────────────────────────────────────────────

-- Lookup is fully public (like genres): anyone can read the vocabulary.
ALTER TABLE "public"."artist_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view artist types" ON "public"."artist_types";
CREATE POLICY "Public can view artist types" ON "public"."artist_types"
    FOR SELECT USING (true);

-- Junction is public-readable only for approved artists (verbatim mirror
-- of the artist_genres policy), so non-approved artists' data stays hidden.
ALTER TABLE "public"."artist_type_assignments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view types of approved artists" ON "public"."artist_type_assignments";
CREATE POLICY "Public can view types of approved artists" ON "public"."artist_type_assignments"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."artists" a
            WHERE a.id = "artist_type_assignments"."artist_id"
              AND a.directory_status = 'approved'::"public"."artist_status"
        )
    );

-- Public roles get SELECT (the RLS policies above gate the rows); writes
-- stay with service_role, as with genres/artist_genres.
GRANT SELECT ON TABLE "public"."artist_types" TO "anon";
GRANT SELECT ON TABLE "public"."artist_types" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_types" TO "service_role";
GRANT USAGE, SELECT ON SEQUENCE "public"."artist_types_id_seq" TO "service_role";

GRANT SELECT ON TABLE "public"."artist_type_assignments" TO "anon";
GRANT SELECT ON TABLE "public"."artist_type_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_type_assignments" TO "service_role";
