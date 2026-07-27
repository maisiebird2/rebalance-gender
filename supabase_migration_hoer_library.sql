-- Migration: hoer_sets / hoer_terms / hoer_term_links — the tables behind the
-- library-driven HÖR sync. Run once in the Supabase SQL editor before running
-- scripts/harvest-hoer-library.mjs. See scripts/HOER-SYNC-REWORK-PLAN.md.
--
-- Why three tables:
--
--   hoer_sets       The library ledger — one row per HÖR set (WordPress post),
--                   keyed on the post id. Replaces hoer_sync_state's single
--                   date cursor: the cursor is now max(post_date) over this
--                   table, which cannot drift out of step with what was
--                   actually ingested. It is also the DURABLE RECORD of every
--                   set: because each row keeps its term_ids, artist
--                   collaborations are derived from this table at query time
--                   (count distinct sets crediting both artists' terms) rather
--                   than counted into the collaborations table — so there is no
--                   stateful counter to double-count when Phase A's deliberate
--                   rewind / modified_after sweep re-reads a set. Phase B's
--                   remaining writes (hoer_terms upserts, genre staging) are all
--                   idempotent, guarded by processed_at as a work queue.
--
--   hoer_terms      HÖR's artist identity space, keyed on the ppma_author
--                   TERM ID. artist_id is NULLABLE: a term is discovered from
--                   a set long before we know who it is. null = unbound
--                   candidate, awaiting the socials match in Phase D. Keying
--                   on term_id rather than slug is deliberate — WP slugs carry
--                   uniqueness suffixes (posi-flo-2, romsy1, ayako-mori-2) and
--                   can change; the term id is stable. Slug-as-identity is the
--                   pathology the HÖR dupe cleanup had to unpick (see
--                   scripts/HOER-STATUS-RESOLUTION-PLAN.md).
--
--   hoer_term_links Socials scraped from /artist/<slug>/, staged against the
--                   TERM rather than an artist — the whole point being that
--                   the artist may not exist yet. Phase D matches these
--                   against artist_links to decide whether the term is
--                   someone we already have. Mirrors artist_harvested_links
--                   in shape (no FK on parsed_platform, unique on the parsed
--                   URL per owner).
--
-- Internal state, same posture as resolved_artists / harvest_failures /
-- artist_legal_names: RLS on, no anon/authenticated policy; service_role (the
-- secret key the scripts use) bypasses RLS.
--
-- Safe to re-run (idempotent).

-- ============================================================
-- hoer_sets — the library ledger
-- ============================================================

CREATE TABLE IF NOT EXISTS "public"."hoer_sets" (
    -- WordPress post id. The stable identity of a set.
    "post_id"           bigint NOT NULL,

    -- WordPress publishes these as naive strings with no zone. Both the local
    -- and _gmt variants are stored WITHOUT time zone so no driver applies an
    -- implicit conversion; the _gmt columns are UTC by WP convention.
    -- post_date is the cursor column: it is what the REST `after` /
    -- `modified_after` params filter on, so the cursor and the query agree.
    "post_date"         timestamp without time zone,
    "post_date_gmt"     timestamp without time zone,
    "post_modified"     timestamp without time zone,
    "post_modified_gmt" timestamp without time zone,

    "set_url"           "text",
    "set_slug"          "text",
    "title"             "text",

    -- Retained rather than discarded: storage is small at ~9,565 rows, and set
    -- descriptions sometimes name collaborators the ppma_author credits miss —
    -- a signal worth having on hand without re-crawling.
    "content"           "text",
    "excerpt"           "text",

    -- post_tag ids (genres) and ppma_author ids (artists). Arrays because a
    -- set has many tags, and ~5% of sets credit two or more artists.
    "tag_ids"           integer[] NOT NULL DEFAULT '{}',
    "term_ids"          integer[] NOT NULL DEFAULT '{}',

    -- The posts feed's expanded `authors` array, verbatim: display_name,
    -- first_name, last_name, description (the full bio), user_id, is_guest.
    -- Kept raw so fields not extracted today can be mined later without
    -- re-crawling — same durable-payload role as api_response_cache.
    "authors"           "jsonb",

    -- Derived: https://hoer.live/artist/<slug>/ per credited author.
    "artist_urls"       "text"[] NOT NULL DEFAULT '{}',

    "ingested_at"       timestamp with time zone DEFAULT "now"() NOT NULL,

    -- null = Phase B has not consumed this set. Phase A resets it to null when
    -- post_modified changes, so genuinely edited sets are re-examined and
    -- untouched ones are skipped.
    "processed_at"      timestamp with time zone,

    CONSTRAINT "hoer_sets_pkey" PRIMARY KEY ("post_id")
);

-- Cursor lookup: max(post_date).
CREATE INDEX IF NOT EXISTS "idx_hoer_sets_post_date"
    ON "public"."hoer_sets" USING "btree" ("post_date" DESC);

-- Phase B's work queue.
CREATE INDEX IF NOT EXISTS "idx_hoer_sets_unprocessed"
    ON "public"."hoer_sets" USING "btree" ("post_date")
    WHERE "processed_at" IS NULL;

-- Phase D replays a newly bound term's sets to apply its genres / collabs.
CREATE INDEX IF NOT EXISTS "idx_hoer_sets_term_ids"
    ON "public"."hoer_sets" USING "gin" ("term_ids");

-- ============================================================
-- hoer_terms — HÖR artist identity, artist_id resolved later
-- ============================================================

CREATE TABLE IF NOT EXISTS "public"."hoer_terms" (
    -- ppma_author term id. Stable; the slug is not.
    "term_id"       integer NOT NULL,

    -- NULL until Phase D binds the term to an artist. ON DELETE SET NULL
    -- rather than CASCADE: deleting our artist row does not mean the artist
    -- stopped existing on HÖR, and the term should fall back to unbound
    -- rather than vanish and be re-seeded from scratch.
    "artist_id"     "uuid" REFERENCES "public"."artists"("id") ON DELETE SET NULL,

    "slug"          "text" NOT NULL,

    -- From the posts feed's authors[]. display_name is the STAGE name
    -- (verified identical to the artist page <h1> on 12/12 sampled).
    -- first_name/last_name are the LEGAL name and go to artist_legal_names --
    -- never ppma_author.name, which is the stage name or the slug 99% of the
    -- time. Populated for only ~29% of authors.
    "display_name"  "text",
    "first_name"    "text",
    "last_name"     "text",

    -- authors[].description — the complete bio (byte-identical to the WP
    -- users API), so no per-artist users call is needed.
    "bio"           "text",

    "wp_user_id"    bigint,
    "is_guest"      boolean,

    -- Portrait found on /artist/<slug>/. One of only two things that still
    -- require scraping the page; the other is socials.
    "image_url"     "text",

    -- Phase C convergence state. resolved_artists cannot be used here because
    -- it is keyed on artist_id, which an unbound term does not have.
    "scraped_at"    timestamp with time zone,

    "bound_at"      timestamp with time zone,

    -- How Phase D arrived at artist_id, so its decisions stay auditable.
    "bind_method"   "text",

    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at"  timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "hoer_terms_pkey" PRIMARY KEY ("term_id"),
    CONSTRAINT "hoer_terms_bind_method_check"
        CHECK ("bind_method" IS NULL
               OR "bind_method" IN ('social_match', 'seeded_new', 'backfill')),
    -- A bound term must record how and when it was bound.
    CONSTRAINT "hoer_terms_bound_consistency"
        CHECK (("artist_id" IS NULL AND "bind_method" IS NULL AND "bound_at" IS NULL)
               OR ("artist_id" IS NOT NULL AND "bind_method" IS NOT NULL AND "bound_at" IS NOT NULL))
);

-- Deliberately NOT unique: two HÖR terms can legitimately bind to one artist
-- (HÖR's own duplicates, e.g. ayako-mori / ayako-mori-2). artist_links'
-- (artist_id, platform) constraint means only one of them supplies the live
-- HÖR link; the second is logged as a conflict for review, not rejected here.
CREATE INDEX IF NOT EXISTS "idx_hoer_terms_artist"
    ON "public"."hoer_terms" USING "btree" ("artist_id")
    WHERE "artist_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_hoer_terms_slug"
    ON "public"."hoer_terms" USING "btree" ("slug");

-- Phase C's work queue: everything not yet scraped, bound or not.
CREATE INDEX IF NOT EXISTS "idx_hoer_terms_unscraped"
    ON "public"."hoer_terms" USING "btree" ("term_id")
    WHERE "scraped_at" IS NULL;

-- Phase D's work queue: scraped but still unbound.
CREATE INDEX IF NOT EXISTS "idx_hoer_terms_unbound"
    ON "public"."hoer_terms" USING "btree" ("term_id")
    WHERE "artist_id" IS NULL AND "scraped_at" IS NOT NULL;

-- ============================================================
-- hoer_term_links — socials staged against the term, pre-identity
-- ============================================================

CREATE TABLE IF NOT EXISTS "public"."hoer_term_links" (
    "id"              integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
    "term_id"         integer NOT NULL
                      REFERENCES "public"."hoer_terms"("term_id") ON DELETE CASCADE,

    -- As listed on the artist page.
    "raw_url"         "text" NOT NULL,

    -- Via the shared classify-platform-url table + CLASSIFY_CONFIGS.hoer
    -- (which already drops HÖR self-links and YouTube). No FK on
    -- parsed_platform, matching artist_harvested_links.
    "parsed_platform" "text",
    "parsed_url"      "text" NOT NULL,

    "discovered_at"   timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "hoer_term_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hoer_term_links_term_parsed_url_key" UNIQUE ("term_id", "parsed_url")
);

CREATE INDEX IF NOT EXISTS "idx_hoer_term_links_term"
    ON "public"."hoer_term_links" USING "btree" ("term_id");

-- Phase D's match probe joins on (parsed_platform, parsed_url) against
-- artist_links, so lead with the URL.
CREATE INDEX IF NOT EXISTS "idx_hoer_term_links_parsed"
    ON "public"."hoer_term_links" USING "btree" ("parsed_url", "parsed_platform");

-- ============================================================
-- Ownership, RLS, grants
-- ============================================================

ALTER TABLE "public"."hoer_sets"       OWNER TO "postgres";
ALTER TABLE "public"."hoer_terms"      OWNER TO "postgres";
ALTER TABLE "public"."hoer_term_links" OWNER TO "postgres";

ALTER TABLE "public"."hoer_sets"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."hoer_terms"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."hoer_term_links" ENABLE ROW LEVEL SECURITY;

-- No anon / authenticated policy: internal harvest state, never public.
GRANT ALL ON TABLE "public"."hoer_sets"       TO "service_role";
GRANT ALL ON TABLE "public"."hoer_terms"      TO "service_role";
GRANT ALL ON TABLE "public"."hoer_term_links" TO "service_role";

GRANT USAGE, SELECT ON SEQUENCE "public"."hoer_term_links_id_seq" TO "service_role";
