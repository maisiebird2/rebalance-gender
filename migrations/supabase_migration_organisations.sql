-- Migration: organisations — record labels, clubs, events as real rows
--
-- Run once in the Supabase SQL editor, then backfill with
--   npm run migrate-labels-to-organisations            (dry run)
--   npm run migrate-labels-to-organisations -- --apply
--
-- Phase 1 of documentation/PROPOSAL-organisations.md. Safe to re-run
-- (CREATE ... IF NOT EXISTS, guarded seeds, idempotent GRANT/REVOKE and
-- policy drops); the whole thing is one transaction.
--
-- Why:
--
--   An artist's labels, crews, clubs and events live in
--   artist_labels(artist_id, name) as FLAT STRINGS. Nothing can be said
--   about the thing named — no links, no type, no location, no notes,
--   no way to record who runs it, and no way to know that "Ostgut Ton"
--   on one artist is the same organisation as "ostgut ton" on another.
--
--   This gives each organisation its own row, with typed relationships
--   to the artists in the directory. artist_labels is NOT touched: the
--   backfill is additive, the read path dual-reads during the
--   transition, and the old table is dropped only in phase 8.
--
-- Shape notes:
--
--   * TYPES ARE MANY-TO-MANY (organisation_type_links). Tresor is a
--     club AND a label; Boiler Room a show AND a promoter. One extra
--     join table now beats a data migration plus every read path later.
--
--   * "WHO RUNS IT" IS A ROLE ON THE JOIN TABLE, not a column.
--     Organisations routinely have several founders, and modelling it
--     as a role means one relationship table serves both directions
--     (artist page "Associated with"; organisation page "Run by").
--     organisations.run_by_text covers people who are not and will not
--     be in the directory.
--
--   * TYPE AND ROLE VOCABULARIES ARE TABLES, NOT POSTGRES ENUMS, for
--     the same reason `platforms` is: "distributor" can be added from
--     the admin panel without a code change.
--
--   * Both vocabularies are MIGRATED AND SEEDED HERE IN ONE GO (the
--     genre_tag_rules precedent), so an empty table later means rows
--     were deleted, not that setup is pending.
--
--   * artist_organisations.role_key is ON DELETE RESTRICT: a role in
--     use cannot be deleted out from under existing associations. The
--     admin panel reports how many associations block a delete rather
--     than surfacing the raw Postgres error.
--
--   * role_key is part of the PRIMARY KEY, so one artist can hold
--     several roles at one organisation (owner AND resident) without
--     duplicate-row hacks.
--
-- Security (§3 of the proposal — in this migration, not a follow-up):
--
--   The July 2026 audit found artists.notes readable through the
--   publishable key. organisations.notes must not repeat that, so the
--   column-grant pattern from
--   supabase_migration_artists_private_columns.sql is applied here from
--   the start: no table-level SELECT for anon/authenticated, per-column
--   grants that EXCLUDE notes.
--
--   Caveat inherited with the pattern: any column added to
--   organisations later is PRIVATE BY DEFAULT for the public roles, and
--   a granted column that is dropped and recreated LOSES ITS GRANT.
--   Re-run the GRANT block after either.
--
--   Consequence: PostgREST rejects select=* on organisations for
--   anon/authenticated. Public-facing queries must list columns
--   explicitly; service-role queries can keep using *.
--
--   No anon INSERT anywhere here (mirrors
--   supabase_migration_artists_revoke_anon_insert.sql).
--
--   NOTE, corrected 2026-08-23: this file originally said public
--   submissions would create organisations server-side with the service
--   key, as 'pending'. Phase 5 decided against it. A submitter may
--   ATTACH an artist to an organisation that already exists and is
--   approved, but a name they type does NOT become a row — it stays in
--   artist_labels until an ADMIN approves the artist, and is promoted
--   then. The reasoning: /api/submit writes the artist as 'unverified'
--   when the email is unconfirmed, so creating organisations there would
--   let anyone past Turnstile insert into a shared, cross-artist
--   namespace where whoever types a name first owns its canonical
--   spelling — and rejected submissions would leave rows behind that
--   nothing links back to. See src/lib/organisation-writes.ts.

BEGIN;

-- ── 1. Lookup: organisation types (many-to-many with organisations) ──────────

CREATE TABLE IF NOT EXISTS "public"."organisation_types" (
    "key"        "text" NOT NULL,
    "label"      "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organisation_types_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "public"."organisation_types" OWNER TO "postgres";

-- `key` is the slugify() form of `label` (lowercase, non-alphanumerics
-- collapsed to _), matching how addPlatform() derives platform keys.
INSERT INTO "public"."organisation_types" ("key", "label", "sort_order") VALUES
    ('record_label', 'record label', 10),
    ('club',         'club',         20),
    ('venue',        'venue',        30),
    ('event',        'event',        40),
    ('festival',     'festival',     50),
    ('party',        'party',        60),
    ('collective',   'collective',   70),
    ('radio',        'radio',        80),
    ('promoter',     'promoter',     90),
    ('agency',       'agency',      100),
    ('distributor',  'distributor', 110)
ON CONFLICT ("key") DO NOTHING;

-- ── 2. Lookup: roles an artist can hold at an organisation ───────────────────

CREATE TABLE IF NOT EXISTS "public"."organisation_roles" (
    "key"        "text" NOT NULL,
    "label"      "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organisation_roles_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "public"."organisation_roles" OWNER TO "postgres";

-- 'associated' is the default, the backfill's value for all 314 existing
-- artist_labels rows, and the fallback when the specifics aren't known —
-- it is exactly what today's flat text means. Everything after it is
-- more specific and gets filled in by hand.
INSERT INTO "public"."organisation_roles" ("key", "label", "sort_order") VALUES
    ('associated',    'associated',    10),
    ('head',          'head',          20),
    ('curator',       'curator',       30),
    ('owner',         'owner',         40),
    ('founder',       'founder',       50),
    ('co_founder',    'co-founder',    60),
    ('resident',      'resident',      70),
    ('label_manager', 'label manager', 80),
    ('a_r',           'A&R',           90),
    ('booker',        'booker',       100),
    ('member',        'member',       110),
    ('releases_on',   'releases on',  120)
ON CONFLICT ("key") DO NOTHING;

-- ── 3. organisations ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."organisations" (
    "id"           "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name"         "text" NOT NULL,
    -- Same generation expression as artists.name_search, character for
    -- character, so the two can be compared as normalised keys and
    -- scripts/lib/hoer-resolve.mjs normalizeName() mirrors both.
    "name_search"  "text" GENERATED ALWAYS AS (
        "regexp_replace"("lower"("public"."immutable_unaccent"("name")), '[^a-z0-9]'::"text", ''::"text", 'g'::"text")
    ) STORED,
    "status"       "text" DEFAULT 'pending'::"text" NOT NULL,
    -- Merge pointer, mirroring artists.duplicate_of: free-text entry will
    -- keep producing "Ostgut Ton" / "ostgut-ton" pairs.
    "duplicate_of" "uuid",
    "description"  "text",
    -- Free text for the people who run it and are NOT in the directory
    -- (labels run by men, etc.). People who ARE get an
    -- artist_organisations row with an owner/founder/head role instead.
    "run_by_text"  "text",
    -- PRIVATE. Admin only, never rendered — excluded from the public
    -- column grants at the bottom of this file.
    "notes"        "text",
    "created_at"   timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at"   timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organisations_status_check"
        CHECK ("status" IN ('pending', 'approved', 'rejected', 'deleted')),
    CONSTRAINT "organisations_duplicate_of_not_self"
        CHECK ("duplicate_of" IS DISTINCT FROM "id")
);

ALTER TABLE "public"."organisations" OWNER TO "postgres";

DO $$ BEGIN
    ALTER TABLE ONLY "public"."organisations"
        ADD CONSTRAINT "organisations_duplicate_of_fkey"
        FOREIGN KEY ("duplicate_of") REFERENCES "public"."organisations"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_organisations_status"
    ON "public"."organisations" ("status");
CREATE INDEX IF NOT EXISTS "idx_organisations_name"
    ON "public"."organisations" ("name");
CREATE INDEX IF NOT EXISTS "idx_organisations_duplicate_of"
    ON "public"."organisations" ("duplicate_of") WHERE "duplicate_of" IS NOT NULL;
-- Exact-key duplicate detection (the merge tool) and name lookup from the
-- backfill both go through name_search; the trigram index additionally
-- serves the admin panel's substring search.
CREATE INDEX IF NOT EXISTS "idx_organisations_name_search"
    ON "public"."organisations" ("name_search");
CREATE INDEX IF NOT EXISTS "idx_organisations_name_search_trgm"
    ON "public"."organisations" USING gin ("name_search" "public"."gin_trgm_ops");

-- Reuse the existing generic trigger function (as artists does).
DROP TRIGGER IF EXISTS "trg_organisations_updated_at" ON "public"."organisations";
CREATE TRIGGER "trg_organisations_updated_at"
    BEFORE UPDATE ON "public"."organisations"
    FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

-- ── 4. organisation_type_links (many-to-many) ────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."organisation_type_links" (
    "organisation_id" "uuid" NOT NULL,
    "type_key"        "text" NOT NULL,
    "created_at"      timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organisation_type_links_pkey" PRIMARY KEY ("organisation_id", "type_key")
);

ALTER TABLE "public"."organisation_type_links" OWNER TO "postgres";

DO $$ BEGIN
    ALTER TABLE ONLY "public"."organisation_type_links"
        ADD CONSTRAINT "organisation_type_links_organisation_id_fkey"
        FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- RESTRICT for the same reason role_key is: a type in use must not be
-- deletable out from under the organisations carrying it.
DO $$ BEGIN
    ALTER TABLE ONLY "public"."organisation_type_links"
        ADD CONSTRAINT "organisation_type_links_type_key_fkey"
        FOREIGN KEY ("type_key") REFERENCES "public"."organisation_types"("key") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_organisation_type_links_type_key"
    ON "public"."organisation_type_links" ("type_key");

-- ── 5. organisation_locations (mirrors artist_locations) ─────────────────────

CREATE TABLE IF NOT EXISTS "public"."organisation_locations" (
    "id"              integer GENERATED BY DEFAULT AS IDENTITY,
    "organisation_id" "uuid" NOT NULL,
    "city"            "text",
    "country"         "text",
    CONSTRAINT "organisation_locations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."organisation_locations" OWNER TO "postgres";

DO $$ BEGIN
    ALTER TABLE ONLY "public"."organisation_locations"
        ADD CONSTRAINT "organisation_locations_organisation_id_fkey"
        FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_organisation_locations_organisation"
    ON "public"."organisation_locations" ("organisation_id");
CREATE INDEX IF NOT EXISTS "idx_organisation_locations_country"
    ON "public"."organisation_locations" ("country");

-- ── 6. organisation_links (mirrors artist_links, same platforms lookup) ──────

CREATE TABLE IF NOT EXISTS "public"."organisation_links" (
    "id"              integer GENERATED BY DEFAULT AS IDENTITY,
    "organisation_id" "uuid" NOT NULL,
    "platform"        "text" NOT NULL,
    "handle"          "text",
    "url"             "text",
    "original_url"    "text",
    "not_found"       boolean DEFAULT false NOT NULL,
    CONSTRAINT "organisation_links_pkey" PRIMARY KEY ("id"),
    -- One link per platform per organisation, as artist_links enforces.
    CONSTRAINT "organisation_links_organisation_platform_unique"
        UNIQUE ("organisation_id", "platform")
);

ALTER TABLE "public"."organisation_links" OWNER TO "postgres";

DO $$ BEGIN
    ALTER TABLE ONLY "public"."organisation_links"
        ADD CONSTRAINT "organisation_links_organisation_id_fkey"
        FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY "public"."organisation_links"
        ADD CONSTRAINT "organisation_links_platform_fkey"
        FOREIGN KEY ("platform") REFERENCES "public"."platforms"("key");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_organisation_links_organisation"
    ON "public"."organisation_links" ("organisation_id");
CREATE INDEX IF NOT EXISTS "idx_organisation_links_platform"
    ON "public"."organisation_links" ("platform");

-- ── 7. artist_organisations (the typed relationship) ─────────────────────────

CREATE TABLE IF NOT EXISTS "public"."artist_organisations" (
    "artist_id"       "uuid" NOT NULL,
    "organisation_id" "uuid" NOT NULL,
    "role_key"        "text" DEFAULT 'associated'::"text" NOT NULL,
    "created_at"      timestamp with time zone DEFAULT "now"() NOT NULL,
    -- role_key in the PK: owner AND resident at the same place is two
    -- rows, not a duplicate-row hack.
    CONSTRAINT "artist_organisations_pkey"
        PRIMARY KEY ("artist_id", "organisation_id", "role_key")
);

ALTER TABLE "public"."artist_organisations" OWNER TO "postgres";

DO $$ BEGIN
    ALTER TABLE ONLY "public"."artist_organisations"
        ADD CONSTRAINT "artist_organisations_artist_id_fkey"
        FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY "public"."artist_organisations"
        ADD CONSTRAINT "artist_organisations_organisation_id_fkey"
        FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- RESTRICT, deliberately: deleting a role that associations still use
-- would silently reshape the data. The admin panel checks first and
-- reports the blocking count.
DO $$ BEGIN
    ALTER TABLE ONLY "public"."artist_organisations"
        ADD CONSTRAINT "artist_organisations_role_key_fkey"
        FOREIGN KEY ("role_key") REFERENCES "public"."organisation_roles"("key") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The PK covers artist-first lookups ("this artist's organisations").
-- The organisation page walks the other way, so index that side too.
CREATE INDEX IF NOT EXISTS "idx_artist_organisations_organisation"
    ON "public"."artist_organisations" ("organisation_id");
CREATE INDEX IF NOT EXISTS "idx_artist_organisations_role_key"
    ON "public"."artist_organisations" ("role_key");

-- ── 8. RLS ───────────────────────────────────────────────────────────────────

-- Vocabularies are public, like platforms and genres: they are the words
-- the UI renders, not data about anyone.
ALTER TABLE "public"."organisation_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view organisation types" ON "public"."organisation_types";
CREATE POLICY "Public can view organisation types" ON "public"."organisation_types"
    FOR SELECT USING (true);

ALTER TABLE "public"."organisation_roles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view organisation roles" ON "public"."organisation_roles";
CREATE POLICY "Public can view organisation roles" ON "public"."organisation_roles"
    FOR SELECT USING (true);

-- Nothing is public until someone has looked at it: the backfill creates
-- every organisation as 'pending'.
ALTER TABLE "public"."organisations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view approved organisations" ON "public"."organisations";
CREATE POLICY "Public can view approved organisations" ON "public"."organisations"
    FOR SELECT USING ("status" = 'approved'::"text");

-- One-sided check: these hang off the organisation, so approval of the
-- organisation is the only gate (mirrors artist_links/artist_locations).
ALTER TABLE "public"."organisation_type_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view types of approved organisations" ON "public"."organisation_type_links";
CREATE POLICY "Public can view types of approved organisations" ON "public"."organisation_type_links"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."organisations" o
            WHERE o.id = "organisation_type_links"."organisation_id"
              AND o.status = 'approved'::"text"
        )
    );

ALTER TABLE "public"."organisation_locations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view locations of approved organisations" ON "public"."organisation_locations";
CREATE POLICY "Public can view locations of approved organisations" ON "public"."organisation_locations"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."organisations" o
            WHERE o.id = "organisation_locations"."organisation_id"
              AND o.status = 'approved'::"text"
        )
    );

ALTER TABLE "public"."organisation_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view links of approved organisations" ON "public"."organisation_links";
CREATE POLICY "Public can view links of approved organisations" ON "public"."organisation_links"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."organisations" o
            WHERE o.id = "organisation_links"."organisation_id"
              AND o.status = 'approved'::"text"
        )
    );

-- TWO-SIDED, unlike artist_labels' one-sided check: this row is a fact
-- about an artist AND about an organisation, so it leaks either way. A
-- pending organisation must not reveal which approved artists were
-- attached to it, and an unapproved artist must not surface through an
-- approved organisation's page.
ALTER TABLE "public"."artist_organisations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can view associations between approved rows" ON "public"."artist_organisations";
CREATE POLICY "Public can view associations between approved rows" ON "public"."artist_organisations"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."artists" a
            WHERE a.id = "artist_organisations"."artist_id"
              AND a.directory_status = 'approved'::"public"."artist_status"
        )
        AND EXISTS (
            SELECT 1 FROM "public"."organisations" o
            WHERE o.id = "artist_organisations"."organisation_id"
              AND o.status = 'approved'::"text"
        )
    );

-- ── 9. Grants ────────────────────────────────────────────────────────────────

-- service_role runs the admin panel, the server actions and the scripts.
GRANT ALL ON TABLE "public"."organisation_types"      TO "service_role";
GRANT ALL ON TABLE "public"."organisation_roles"      TO "service_role";
GRANT ALL ON TABLE "public"."organisations"           TO "service_role";
GRANT ALL ON TABLE "public"."organisation_type_links" TO "service_role";
GRANT ALL ON TABLE "public"."organisation_locations"  TO "service_role";
GRANT ALL ON TABLE "public"."organisation_links"      TO "service_role";
GRANT ALL ON TABLE "public"."artist_organisations"    TO "service_role";

-- Public roles get SELECT only; the RLS policies above choose the rows.
GRANT SELECT ON TABLE "public"."organisation_types"      TO "anon", "authenticated";
GRANT SELECT ON TABLE "public"."organisation_roles"      TO "anon", "authenticated";
GRANT SELECT ON TABLE "public"."organisation_type_links" TO "anon", "authenticated";
GRANT SELECT ON TABLE "public"."organisation_locations"  TO "anon", "authenticated";
GRANT SELECT ON TABLE "public"."organisation_links"      TO "anon", "authenticated";
GRANT SELECT ON TABLE "public"."artist_organisations"    TO "anon", "authenticated";

-- organisations is the column-grant case (see the header): notes is
-- admin-only, so there is no table-level SELECT to inherit from.
-- name_search must stay granted — a role needs SELECT on a column to
-- use it in a WHERE clause, even when the column isn't returned.
REVOKE SELECT ON TABLE "public"."organisations" FROM "anon", "authenticated";
GRANT SELECT (
  "id",
  "name",
  "name_search",
  "status",
  "duplicate_of",
  "description",
  "run_by_text",
  "created_at",
  "updated_at"
) ON TABLE "public"."organisations" TO "anon", "authenticated";

-- No public writes anywhere. Supabase's permissive defaults don't reach
-- tables created by `postgres`, but say it explicitly so the ACL tells
-- the truth on its own — the same posture as
-- supabase_migration_artists_revoke_anon_insert.sql.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE "public"."organisations",
           "public"."organisation_types",
           "public"."organisation_roles",
           "public"."organisation_type_links",
           "public"."organisation_locations",
           "public"."organisation_links",
           "public"."artist_organisations"
  FROM "anon", "authenticated";

-- IDENTITY columns need their sequence usable by the writer.
GRANT USAGE, SELECT ON SEQUENCE "public"."organisation_locations_id_seq" TO "service_role";
GRANT USAGE, SELECT ON SEQUENCE "public"."organisation_links_id_seq" TO "service_role";

COMMIT;
