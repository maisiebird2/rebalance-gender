


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."artist_status" AS ENUM (
    'approved',
    'pending',
    'rejected',
    'not_eligible',
    'search_input',
    'sc_followee',
    'duplicate',
    'unverified'
);


ALTER TYPE "public"."artist_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_recommended_is_approved"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if not exists (
    select 1 from artists
    where id = new.recommended_artist_id
    and directory_status = 'approved'
  ) then
    raise exception 'recommended_artist_id (%) must reference an approved directory artist', new.recommended_artist_id;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."check_recommended_is_approved"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_enrichment_on_url_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- IS DISTINCT FROM handles NULLs correctly (unlike !=).
  IF NEW.url IS DISTINCT FROM OLD.url THEN
    UPDATE artist_enrichment
       SET sync_error            = NULL,
           follow_graph_built_at = NULL
     WHERE artist_id = NEW.artist_id
       AND platform  = NEW.platform;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."clear_enrichment_on_url_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."immutable_unaccent"("text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT unaccent($1);
$_$;


ALTER FUNCTION "public"."immutable_unaccent"("text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_submitter_email"("p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into submitter_emails (email, status, submission_count)
  values (p_email, 'unverified', 1)
  on conflict (email) do update
    set submission_count = submitter_emails.submission_count + 1;
end;
$$;


ALTER FUNCTION "public"."upsert_submitter_email"("p_email" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."artist_aliases" (
    "id" integer NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "name" "text" NOT NULL
);


ALTER TABLE "public"."artist_aliases" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_aliases_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_aliases_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_aliases_id_seq" OWNED BY "public"."artist_aliases"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_bandcamp_albums" (
    "id" integer NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "bandcamp_id" "text" NOT NULL,
    "item_type" "text" NOT NULL,
    "title" "text",
    "url" "text",
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."artist_bandcamp_albums" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_bandcamp_albums_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_bandcamp_albums_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_bandcamp_albums_id_seq" OWNED BY "public"."artist_bandcamp_albums"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_enrichment" (
    "id" integer NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "platform" "text" NOT NULL,
    "external_id" "text",
    "profile_image_url" "text",
    "bio" "text",
    "follower_count" integer,
    "track_count" integer,
    "recent_tracks" "jsonb",
    "last_synced_at" timestamp with time zone,
    "sync_error" "text",
    "bio_sanitized" "text",
    "follow_graph_built_at" timestamp with time zone,
    "playlists" "jsonb"
);


ALTER TABLE "public"."artist_enrichment" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_enrichment_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_enrichment_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_enrichment_id_seq" OWNED BY "public"."artist_enrichment"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_genres" (
    "artist_id" "uuid" NOT NULL,
    "genre_id" integer NOT NULL
);


ALTER TABLE "public"."artist_genres" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."artist_harvested_bios" (
    "id" integer NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "source_platform" "text" DEFAULT 'soundcloud'::"text" NOT NULL,
    "source_url" "text" NOT NULL,
    "raw_bio" "text",
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."artist_harvested_bios" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_harvested_bios_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_harvested_bios_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_harvested_bios_id_seq" OWNED BY "public"."artist_harvested_bios"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_harvested_genres" (
    "id" bigint NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "source_platform" "text" NOT NULL,
    "raw_tag" "text" NOT NULL,
    "tag_count" integer,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "genre_id" integer,
    "skipped" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."artist_harvested_genres" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_harvested_genres_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_harvested_genres_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_harvested_genres_id_seq" OWNED BY "public"."artist_harvested_genres"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_harvested_links" (
    "id" integer NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "source_platform" "text" DEFAULT 'soundcloud'::"text" NOT NULL,
    "source_url" "text" NOT NULL,
    "raw_url" "text" NOT NULL,
    "parsed_platform" "text",
    "parsed_url" "text" NOT NULL,
    "discovered_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "artist_links_url" "text"
);


ALTER TABLE "public"."artist_harvested_links" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_harvested_links_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_harvested_links_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_harvested_links_id_seq" OWNED BY "public"."artist_harvested_links"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_labels" (
    "id" integer NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "name" "text" NOT NULL
);


ALTER TABLE "public"."artist_labels" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_labels_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_labels_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_labels_id_seq" OWNED BY "public"."artist_labels"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_links" (
    "id" integer NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "platform" "text" NOT NULL,
    "handle" "text",
    "url" "text",
    "not_found" boolean DEFAULT false NOT NULL,
    "original_url" "text"
);


ALTER TABLE "public"."artist_links" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_links_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_links_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_links_id_seq" OWNED BY "public"."artist_links"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_locations" (
    "id" integer NOT NULL,
    "artist_id" "uuid",
    "city" "text",
    "country" "text",
    "raw_text" "text"
);


ALTER TABLE "public"."artist_locations" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."artist_locations_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artist_locations_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artist_locations_id_seq" OWNED BY "public"."artist_locations"."id";



CREATE TABLE IF NOT EXISTS "public"."artist_revisions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "submitted_by_email" "text",
    "status" "text" DEFAULT 'unverified'::"text" NOT NULL,
    "submitter_notes" "text",
    "revision_data" "jsonb" NOT NULL,
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "artist_revisions_status_check" CHECK (("status" = ANY (ARRAY['unverified'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."artist_revisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."artist_similarity_scores" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "source_artist_id" "uuid" NOT NULL,
    "recommended_artist_id" "uuid" NOT NULL,
    "genre_score" numeric(5,4) DEFAULT 0 NOT NULL,
    "mb_tag_score" numeric(5,4) DEFAULT 0 NOT NULL,
    "mb_collab_score" numeric(5,4) DEFAULT 0 NOT NULL,
    "total_score" numeric(5,4) NOT NULL,
    "rank" smallint NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sc_direct_follow_score" numeric(5,4) DEFAULT 0 NOT NULL,
    "sc_co_follow_score" numeric(5,4) DEFAULT 0 NOT NULL,
    CONSTRAINT "artist_similarity_scores_rank_check" CHECK ((("rank" >= 1) AND ("rank" <= 10))),
    CONSTRAINT "chk_similarity_no_self" CHECK (("source_artist_id" <> "recommended_artist_id"))
);


ALTER TABLE "public"."artist_similarity_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."artists" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "pronoun_id" integer,
    "labels" "text",
    "notes" "text",
    "directory_status" "public"."artist_status" DEFAULT 'approved'::"public"."artist_status" NOT NULL,
    "submitted_by_email" "text",
    "submitted_at" timestamp with time zone,
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "profile_image_url" "text",
    "profile_image_source" "text",
    "profile_image_fetched_at" timestamp with time zone,
    "booking_info" "text",
    "management_info" "text",
    "contact_info" "text",
    "linktree_url" "text",
    "deleted" boolean DEFAULT false NOT NULL,
    "name_search" "text" GENERATED ALWAYS AS ("lower"("replace"("public"."immutable_unaccent"("name"), ' '::"text", ''::"text"))) STORED,
    "gender_mb" "text"
);


ALTER TABLE "public"."artists" OWNER TO "postgres";


COMMENT ON COLUMN "public"."artists"."directory_status" IS 'approved/pending/rejected: directory moderation workflow (unchanged). not_eligible: artist exists only as a graph node (e.g. discovered via a directory artist''s SoundCloud followings, or a live cold-start search) and is not, and may never become, a directory listing.';



CREATE TABLE IF NOT EXISTS "public"."genres" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    CONSTRAINT "genres_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'deleted'::"text"])))
);


ALTER TABLE "public"."genres" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."genres_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."genres_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."genres_id_seq" OWNED BY "public"."genres"."id";



CREATE TABLE IF NOT EXISTS "public"."lastfm_similar_artists" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "similar_artist_name" "text" NOT NULL,
    "similar_artist_mbid" "text",
    "match_score" double precision NOT NULL,
    "rank" smallint NOT NULL,
    "similar_artist_id" "uuid",
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "similar_artist_lfm_url" "text"
);


ALTER TABLE "public"."lastfm_similar_artists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mb_collaborations" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "artist_id_a" "uuid" NOT NULL,
    "artist_id_b" "uuid" NOT NULL,
    "collab_count" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_mb_collab_ordered" CHECK (("artist_id_a" < "artist_id_b"))
);


ALTER TABLE "public"."mb_collaborations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mb_tags" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "tag" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mb_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pending_artist_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "artist_id" "uuid" NOT NULL,
    "service" "text" NOT NULL,
    "candidate_rank" integer NOT NULL,
    "external_id" "text" NOT NULL,
    "external_name" "text" NOT NULL,
    "confidence" double precision NOT NULL,
    "score_name" double precision,
    "score_genre" double precision,
    "score_location" double precision,
    "score_bio" double precision,
    "score_popularity" double precision,
    "api_data" "jsonb",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "review_note" "text",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "url" "text",
    CONSTRAINT "pending_artist_links_service_check" CHECK (("service" = ANY (ARRAY['lastfm'::"text", 'musicbrainz'::"text", 'spotify'::"text"]))),
    CONSTRAINT "pending_artist_links_status_check" CHECK (("status" = ANY (ARRAY['best match'::"text", 'close match'::"text", 'tie'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text", 'skipped'::"text", 'loaded'::"text"])))
);


ALTER TABLE "public"."pending_artist_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platforms" (
    "key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "search_url_template" "text"
);


ALTER TABLE "public"."platforms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pronouns" (
    "id" integer NOT NULL,
    "value" "text" NOT NULL
);


ALTER TABLE "public"."pronouns" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."pronouns_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."pronouns_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."pronouns_id_seq" OWNED BY "public"."pronouns"."id";



CREATE TABLE IF NOT EXISTS "public"."resolved_artists" (
    "artist_id" "uuid" NOT NULL,
    "service" "text" NOT NULL,
    "resolved_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."resolved_artists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sc_follow_edges" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "follower_artist_id" "uuid" NOT NULL,
    "followed_artist_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_sc_follow_no_self" CHECK (("follower_artist_id" <> "followed_artist_id"))
);


ALTER TABLE "public"."sc_follow_edges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."submitter_emails" (
    "email" "text" NOT NULL,
    "status" "text" DEFAULT 'unverified'::"text" NOT NULL,
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "verified_at" timestamp with time zone,
    "submission_count" integer DEFAULT 0 NOT NULL,
    "blocked_at" timestamp with time zone,
    "block_reason" "text",
    CONSTRAINT "submitter_emails_status_check" CHECK (("status" = ANY (ARRAY['unverified'::"text", 'verified'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."submitter_emails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."verification_tokens" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "token" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "email" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "verification_tokens_target_type_check" CHECK (("target_type" = ANY (ARRAY['artist'::"text", 'revision'::"text"])))
);


ALTER TABLE "public"."verification_tokens" OWNER TO "postgres";


ALTER TABLE ONLY "public"."artist_aliases" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_aliases_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_bandcamp_albums" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_bandcamp_albums_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_enrichment" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_enrichment_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_harvested_bios" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_harvested_bios_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_harvested_genres" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_harvested_genres_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_harvested_links" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_harvested_links_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_labels" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_labels_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_links" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_links_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_locations" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artist_locations_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."genres" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."genres_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."pronouns" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pronouns_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artist_aliases"
    ADD CONSTRAINT "artist_aliases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_bandcamp_albums"
    ADD CONSTRAINT "artist_bandcamp_albums_artist_id_bandcamp_id_key" UNIQUE ("artist_id", "bandcamp_id");



ALTER TABLE ONLY "public"."artist_bandcamp_albums"
    ADD CONSTRAINT "artist_bandcamp_albums_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_enrichment"
    ADD CONSTRAINT "artist_enrichment_artist_id_platform_key" UNIQUE ("artist_id", "platform");



ALTER TABLE ONLY "public"."artist_enrichment"
    ADD CONSTRAINT "artist_enrichment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_genres"
    ADD CONSTRAINT "artist_genres_pkey" PRIMARY KEY ("artist_id", "genre_id");



ALTER TABLE ONLY "public"."artist_harvested_bios"
    ADD CONSTRAINT "artist_harvested_bios_artist_id_source_platform_key" UNIQUE ("artist_id", "source_platform");



ALTER TABLE ONLY "public"."artist_harvested_bios"
    ADD CONSTRAINT "artist_harvested_bios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_harvested_genres"
    ADD CONSTRAINT "artist_harvested_genres_artist_id_source_platform_raw_tag_key" UNIQUE ("artist_id", "source_platform", "raw_tag");



ALTER TABLE ONLY "public"."artist_harvested_genres"
    ADD CONSTRAINT "artist_harvested_genres_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_harvested_links"
    ADD CONSTRAINT "artist_harvested_links_artist_id_parsed_url_key" UNIQUE ("artist_id", "parsed_url");



ALTER TABLE ONLY "public"."artist_harvested_links"
    ADD CONSTRAINT "artist_harvested_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_labels"
    ADD CONSTRAINT "artist_labels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_links"
    ADD CONSTRAINT "artist_links_artist_id_platform_url_key" UNIQUE ("artist_id", "platform", "url");



ALTER TABLE ONLY "public"."artist_links"
    ADD CONSTRAINT "artist_links_artist_platform_unique" UNIQUE ("artist_id", "platform");



ALTER TABLE ONLY "public"."artist_links"
    ADD CONSTRAINT "artist_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_locations"
    ADD CONSTRAINT "artist_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_revisions"
    ADD CONSTRAINT "artist_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_similarity_scores"
    ADD CONSTRAINT "artist_similarity_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artist_similarity_scores"
    ADD CONSTRAINT "artist_similarity_scores_source_artist_id_rank_key" UNIQUE ("source_artist_id", "rank");



ALTER TABLE ONLY "public"."artist_similarity_scores"
    ADD CONSTRAINT "artist_similarity_scores_source_artist_id_recommended_artis_key" UNIQUE ("source_artist_id", "recommended_artist_id");



ALTER TABLE ONLY "public"."artists"
    ADD CONSTRAINT "artists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."genres"
    ADD CONSTRAINT "genres_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."genres"
    ADD CONSTRAINT "genres_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lastfm_similar_artists"
    ADD CONSTRAINT "lastfm_similar_artists_artist_id_similar_artist_name_key" UNIQUE ("artist_id", "similar_artist_name");



ALTER TABLE ONLY "public"."lastfm_similar_artists"
    ADD CONSTRAINT "lastfm_similar_artists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mb_collaborations"
    ADD CONSTRAINT "mb_collaborations_artist_id_a_artist_id_b_key" UNIQUE ("artist_id_a", "artist_id_b");



ALTER TABLE ONLY "public"."mb_collaborations"
    ADD CONSTRAINT "mb_collaborations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mb_tags"
    ADD CONSTRAINT "mb_tags_artist_id_tag_key" UNIQUE ("artist_id", "tag");



ALTER TABLE ONLY "public"."mb_tags"
    ADD CONSTRAINT "mb_tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pending_artist_links"
    ADD CONSTRAINT "pending_artist_links_artist_id_service_external_id_key" UNIQUE ("artist_id", "service", "external_id");



ALTER TABLE ONLY "public"."pending_artist_links"
    ADD CONSTRAINT "pending_artist_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platforms"
    ADD CONSTRAINT "platforms_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."pronouns"
    ADD CONSTRAINT "pronouns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pronouns"
    ADD CONSTRAINT "pronouns_value_key" UNIQUE ("value");



ALTER TABLE ONLY "public"."resolved_artists"
    ADD CONSTRAINT "resolved_artists_pkey" PRIMARY KEY ("artist_id", "service");



ALTER TABLE ONLY "public"."sc_follow_edges"
    ADD CONSTRAINT "sc_follow_edges_follower_artist_id_followed_artist_id_key" UNIQUE ("follower_artist_id", "followed_artist_id");



ALTER TABLE ONLY "public"."sc_follow_edges"
    ADD CONSTRAINT "sc_follow_edges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."submitter_emails"
    ADD CONSTRAINT "submitter_emails_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."verification_tokens"
    ADD CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."verification_tokens"
    ADD CONSTRAINT "verification_tokens_token_key" UNIQUE ("token");



CREATE INDEX "idx_ahg_artist" ON "public"."artist_harvested_genres" USING "btree" ("artist_id");



CREATE INDEX "idx_ahg_genre" ON "public"."artist_harvested_genres" USING "btree" ("genre_id") WHERE ("genre_id" IS NOT NULL);



CREATE INDEX "idx_ahg_pending" ON "public"."artist_harvested_genres" USING "btree" ("artist_id") WHERE (("genre_id" IS NULL) AND ("skipped" = false));



CREATE INDEX "idx_ahg_platform" ON "public"."artist_harvested_genres" USING "btree" ("source_platform");



CREATE INDEX "idx_artist_aliases_artist" ON "public"."artist_aliases" USING "btree" ("artist_id");



CREATE INDEX "idx_artist_enrichment_platform" ON "public"."artist_enrichment" USING "btree" ("platform");



CREATE INDEX "idx_artist_genres_genre" ON "public"."artist_genres" USING "btree" ("genre_id");



CREATE INDEX "idx_artist_harvested_bios_artist" ON "public"."artist_harvested_bios" USING "btree" ("artist_id");



CREATE INDEX "idx_artist_harvested_links_artist" ON "public"."artist_harvested_links" USING "btree" ("artist_id");



CREATE INDEX "idx_artist_harvested_links_platform" ON "public"."artist_harvested_links" USING "btree" ("parsed_platform");



CREATE INDEX "idx_artist_labels_artist" ON "public"."artist_labels" USING "btree" ("artist_id");



CREATE INDEX "idx_artist_links_artist" ON "public"."artist_links" USING "btree" ("artist_id");



CREATE INDEX "idx_artist_links_platform" ON "public"."artist_links" USING "btree" ("platform");



CREATE INDEX "idx_artist_locations_artist" ON "public"."artist_locations" USING "btree" ("artist_id");



CREATE INDEX "idx_artist_locations_country" ON "public"."artist_locations" USING "btree" ("country");



CREATE INDEX "idx_artist_revisions_artist" ON "public"."artist_revisions" USING "btree" ("artist_id");



CREATE INDEX "idx_artist_revisions_status" ON "public"."artist_revisions" USING "btree" ("status");



CREATE INDEX "idx_artists_deleted" ON "public"."artists" USING "btree" ("deleted");



CREATE INDEX "idx_artists_directory_status" ON "public"."artists" USING "btree" ("directory_status");



CREATE INDEX "idx_artists_name" ON "public"."artists" USING "btree" ("name");



CREATE INDEX "idx_artists_name_search_trgm_approved" ON "public"."artists" USING "gin" ("name_search" "public"."gin_trgm_ops") WHERE (("directory_status" = 'approved'::"public"."artist_status") AND ("deleted" = false));



CREATE INDEX "idx_artists_pronoun" ON "public"."artists" USING "btree" ("pronoun_id");



CREATE INDEX "idx_bandcamp_albums_artist" ON "public"."artist_bandcamp_albums" USING "btree" ("artist_id", "sort_order");



CREATE INDEX "idx_genres_status" ON "public"."genres" USING "btree" ("status");



CREATE INDEX "idx_lastfm_similar_artist" ON "public"."lastfm_similar_artists" USING "btree" ("artist_id");



CREATE INDEX "idx_lastfm_similar_in_dir" ON "public"."lastfm_similar_artists" USING "btree" ("similar_artist_id") WHERE ("similar_artist_id" IS NOT NULL);



CREATE INDEX "idx_lastfm_similar_lfm_url" ON "public"."lastfm_similar_artists" USING "btree" ("similar_artist_lfm_url") WHERE ("similar_artist_lfm_url" IS NOT NULL);



CREATE INDEX "idx_mb_collab_artist_a" ON "public"."mb_collaborations" USING "btree" ("artist_id_a");



CREATE INDEX "idx_mb_collab_artist_b" ON "public"."mb_collaborations" USING "btree" ("artist_id_b");



CREATE INDEX "idx_mb_tags_artist" ON "public"."mb_tags" USING "btree" ("artist_id");



CREATE INDEX "idx_mb_tags_tag" ON "public"."mb_tags" USING "btree" ("tag");



CREATE INDEX "idx_pending_artist" ON "public"."pending_artist_links" USING "btree" ("artist_id");



CREATE INDEX "idx_pending_service" ON "public"."pending_artist_links" USING "btree" ("service", "status");



CREATE INDEX "idx_pending_status" ON "public"."pending_artist_links" USING "btree" ("status");



CREATE INDEX "idx_sc_follow_followed" ON "public"."sc_follow_edges" USING "btree" ("followed_artist_id");



CREATE INDEX "idx_sc_follow_follower" ON "public"."sc_follow_edges" USING "btree" ("follower_artist_id");



CREATE INDEX "idx_similarity_source" ON "public"."artist_similarity_scores" USING "btree" ("source_artist_id");



CREATE INDEX "idx_verification_tokens_target" ON "public"."verification_tokens" USING "btree" ("target_type", "target_id");



CREATE INDEX "idx_verification_tokens_token" ON "public"."verification_tokens" USING "btree" ("token");



CREATE OR REPLACE TRIGGER "set_artist_revisions_updated_at" BEFORE UPDATE ON "public"."artist_revisions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_artist_links_url_change" AFTER UPDATE OF "url" ON "public"."artist_links" FOR EACH ROW EXECUTE FUNCTION "public"."clear_enrichment_on_url_change"();



CREATE OR REPLACE TRIGGER "trg_artists_updated_at" BEFORE UPDATE ON "public"."artists" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_mb_collaborations_updated_at" BEFORE UPDATE ON "public"."mb_collaborations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_similarity_recommended_is_approved" BEFORE INSERT OR UPDATE ON "public"."artist_similarity_scores" FOR EACH ROW EXECUTE FUNCTION "public"."check_recommended_is_approved"();



ALTER TABLE ONLY "public"."artist_aliases"
    ADD CONSTRAINT "artist_aliases_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_bandcamp_albums"
    ADD CONSTRAINT "artist_bandcamp_albums_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_enrichment"
    ADD CONSTRAINT "artist_enrichment_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_enrichment"
    ADD CONSTRAINT "artist_enrichment_platform_fkey" FOREIGN KEY ("platform") REFERENCES "public"."platforms"("key");



ALTER TABLE ONLY "public"."artist_genres"
    ADD CONSTRAINT "artist_genres_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_genres"
    ADD CONSTRAINT "artist_genres_genre_id_fkey" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_harvested_bios"
    ADD CONSTRAINT "artist_harvested_bios_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_harvested_genres"
    ADD CONSTRAINT "artist_harvested_genres_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_harvested_genres"
    ADD CONSTRAINT "artist_harvested_genres_genre_id_fkey" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."artist_harvested_links"
    ADD CONSTRAINT "artist_harvested_links_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_labels"
    ADD CONSTRAINT "artist_labels_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_links"
    ADD CONSTRAINT "artist_links_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_links"
    ADD CONSTRAINT "artist_links_platform_fkey" FOREIGN KEY ("platform") REFERENCES "public"."platforms"("key");



ALTER TABLE ONLY "public"."artist_locations"
    ADD CONSTRAINT "artist_locations_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_revisions"
    ADD CONSTRAINT "artist_revisions_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_similarity_scores"
    ADD CONSTRAINT "artist_similarity_scores_recommended_artist_id_fkey" FOREIGN KEY ("recommended_artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artist_similarity_scores"
    ADD CONSTRAINT "artist_similarity_scores_source_artist_id_fkey" FOREIGN KEY ("source_artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artists"
    ADD CONSTRAINT "artists_profile_image_source_fkey" FOREIGN KEY ("profile_image_source") REFERENCES "public"."platforms"("key");



ALTER TABLE ONLY "public"."artists"
    ADD CONSTRAINT "artists_pronoun_id_fkey" FOREIGN KEY ("pronoun_id") REFERENCES "public"."pronouns"("id");



ALTER TABLE ONLY "public"."lastfm_similar_artists"
    ADD CONSTRAINT "lastfm_similar_artists_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lastfm_similar_artists"
    ADD CONSTRAINT "lastfm_similar_artists_similar_artist_id_fkey" FOREIGN KEY ("similar_artist_id") REFERENCES "public"."artists"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."mb_collaborations"
    ADD CONSTRAINT "mb_collaborations_artist_id_a_fkey" FOREIGN KEY ("artist_id_a") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mb_collaborations"
    ADD CONSTRAINT "mb_collaborations_artist_id_b_fkey" FOREIGN KEY ("artist_id_b") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mb_tags"
    ADD CONSTRAINT "mb_tags_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pending_artist_links"
    ADD CONSTRAINT "pending_artist_links_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."resolved_artists"
    ADD CONSTRAINT "resolved_artists_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sc_follow_edges"
    ADD CONSTRAINT "sc_follow_edges_followed_artist_id_fkey" FOREIGN KEY ("followed_artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sc_follow_edges"
    ADD CONSTRAINT "sc_follow_edges_follower_artist_id_fkey" FOREIGN KEY ("follower_artist_id") REFERENCES "public"."artists"("id") ON DELETE CASCADE;



CREATE POLICY "Anyone can submit a pending artist" ON "public"."artists" FOR INSERT WITH CHECK (("directory_status" = 'pending'::"public"."artist_status"));



CREATE POLICY "Public can view aliases of approved artists" ON "public"."artist_aliases" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_aliases"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));



CREATE POLICY "Public can view approved artists" ON "public"."artists" FOR SELECT USING (("directory_status" = 'approved'::"public"."artist_status"));



CREATE POLICY "Public can view bandcamp albums of approved artists" ON "public"."artist_bandcamp_albums" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_bandcamp_albums"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));



CREATE POLICY "Public can view enrichment of approved artists" ON "public"."artist_enrichment" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_enrichment"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));



CREATE POLICY "Public can view genres" ON "public"."genres" FOR SELECT USING (true);



CREATE POLICY "Public can view genres of approved artists" ON "public"."artist_genres" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_genres"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));



CREATE POLICY "Public can view labels of approved artists" ON "public"."artist_labels" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_labels"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));



CREATE POLICY "Public can view links of approved artists" ON "public"."artist_links" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_links"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));



CREATE POLICY "Public can view locations of approved artists" ON "public"."artist_locations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."artists" "a"
  WHERE (("a"."id" = "artist_locations"."artist_id") AND ("a"."directory_status" = 'approved'::"public"."artist_status")))));



CREATE POLICY "Public can view platforms" ON "public"."platforms" FOR SELECT USING (true);



CREATE POLICY "Public can view pronouns" ON "public"."pronouns" FOR SELECT USING (true);



CREATE POLICY "Public can view similarity scores" ON "public"."artist_similarity_scores" FOR SELECT USING (true);



ALTER TABLE "public"."artist_aliases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_bandcamp_albums" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_enrichment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_genres" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_harvested_bios" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_harvested_genres" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_harvested_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_labels" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_locations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_revisions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artist_similarity_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."artists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."genres" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lastfm_similar_artists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mb_collaborations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mb_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pending_artist_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platforms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pronouns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."resolved_artists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sc_follow_edges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."submitter_emails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."verification_tokens" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent"("regdictionary", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent_init"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unaccent_lexize"("internal", "internal", "internal", "internal") TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_submitter_email"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_submitter_email"("p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";


















GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_aliases" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_aliases" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_aliases_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_bandcamp_albums" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_bandcamp_albums" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_bandcamp_albums" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_bandcamp_albums_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_enrichment" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_enrichment" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_enrichment" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_enrichment_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_genres" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_genres" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_genres" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_harvested_bios" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_harvested_bios" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_harvested_bios" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_harvested_bios_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_harvested_genres" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_harvested_genres" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_harvested_genres" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_harvested_genres_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_harvested_links" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_harvested_links" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_harvested_links" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_harvested_links_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_labels" TO "anon";
GRANT ALL ON TABLE "public"."artist_labels" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_labels" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_labels_id_seq" TO "service_role";
GRANT SELECT,USAGE ON SEQUENCE "public"."artist_labels_id_seq" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_links" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_links" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_links_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_locations" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_locations" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."artist_locations_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_revisions" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_revisions" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."artist_revisions" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_similarity_scores" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artist_similarity_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."artist_similarity_scores" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artists" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."artists" TO "authenticated";
GRANT ALL ON TABLE "public"."artists" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."genres" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."genres" TO "authenticated";
GRANT ALL ON TABLE "public"."genres" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."genres_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lastfm_similar_artists" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."lastfm_similar_artists" TO "authenticated";
GRANT ALL ON TABLE "public"."lastfm_similar_artists" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."mb_collaborations" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."mb_collaborations" TO "authenticated";
GRANT ALL ON TABLE "public"."mb_collaborations" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."mb_tags" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."mb_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."mb_tags" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pending_artist_links" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pending_artist_links" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_artist_links" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."platforms" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."platforms" TO "authenticated";
GRANT ALL ON TABLE "public"."platforms" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pronouns" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."pronouns" TO "authenticated";
GRANT ALL ON TABLE "public"."pronouns" TO "service_role";



GRANT SELECT,USAGE ON SEQUENCE "public"."pronouns_id_seq" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."resolved_artists" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."resolved_artists" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."resolved_artists" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sc_follow_edges" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sc_follow_edges" TO "authenticated";
GRANT ALL ON TABLE "public"."sc_follow_edges" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."submitter_emails" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."submitter_emails" TO "authenticated";
GRANT ALL ON TABLE "public"."submitter_emails" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."verification_tokens" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."verification_tokens" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."verification_tokens" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";































