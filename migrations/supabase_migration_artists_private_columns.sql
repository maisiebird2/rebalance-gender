-- Migration: column-level SELECT grants on artists (private columns)
--
-- Run once in the Supabase SQL editor. Safe to re-run (REVOKE/GRANT are
-- idempotent, and the whole thing is one transaction).
--
-- Why:
--
--   The RLS policy on artists ("Public can view approved artists")
--   restricts which ROWS the public API roles can read, but not which
--   COLUMNS — and PostgREST lets the caller pick columns. A 2026-07
--   security audit confirmed against production that anyone holding the
--   publishable key (i.e. anyone, it ships in the browser bundle) could
--   read admin-only columns off approved rows:
--
--     - submitted_by_email  third-party PII (submitter addresses)
--     - notes               "Internal notes (admin only — never shown
--                           publicly)" per our own edit form
--
--   Fix: the column-grant pattern. Revoke table-level SELECT from the
--   public API roles, then re-grant SELECT on the public columns only.
--   (artist_legal_names solved the same class of problem by giving the
--   public roles no read access at all; artists needs the per-column
--   variant because most of the table IS public.)
--
-- What stays public vs. private:
--
--   PUBLIC (granted below): everything the site renders or filters on.
--   booking_info / management_info / contact_info stay public on
--   purpose — the artist page displays them (decision 2026-07-29).
--   name_search must stay granted: directory search filters on it (a
--   role needs SELECT on a column to use it in a WHERE clause, even
--   when the column isn't returned).
--
--   linktree_url used to be granted here as "legacy but harmless". It
--   was dropped from artists by
--   supabase_migration_drop_artists_linktree_url.sql and removed from
--   the list below in the same change — leaving it would make this
--   file fail with "column linktree_url does not exist".
--
--   PRIVATE (not granted): admin/submission metadata and anything the
--   public UI never shows.
--     - notes               internal admin notes
--     - submitted_by_email  submitter PII
--     - submitted_at        submission metadata (admin panel only)
--     - reviewed_at         submission metadata (admin panel only)
--     - gender_mb           third-party gender attribution from
--                           MusicBrainz; admin review data, never
--                           rendered publicly
--
--   service_role is untouched and keeps full access (admin panel,
--   enrichment scripts). The INSERT grant + "Anyone can submit a
--   pending artist" policy are also untouched: writing your own data in
--   is not the same risk as reading others' data out.
--
-- Caveats to keep in mind after this runs:
--
--   1. PostgREST rejects `select=*` on artists for anon/authenticated
--      once column grants exist (the role can no longer read every
--      column, and `*` means "all of them"). Public-facing queries must
--      list columns explicitly — src/lib/queries.ts ARTIST_SELECT was
--      changed to do exactly that in the same commit as this file.
--      Service-role queries can keep using `*`.
--
--   2. New columns added to artists are now PRIVATE BY DEFAULT for the
--      public roles (there is no table-level SELECT to inherit). If a
--      future column should be public, grant it explicitly:
--        GRANT SELECT (new_column) ON public.artists
--          TO anon, authenticated;
--
--   3. If a granted column is ever dropped and recreated (as
--      supabase_migration_name_search_strip_punctuation.sql did with
--      name_search), the recreated column loses its grant — re-run the
--      GRANT below afterwards or search breaks for anonymous visitors.
--
-- Verification: scripts/check-artists-column-grants.mjs probes
-- production with the publishable key — private columns must be denied,
-- public directory reads must still work.
--
--   npm run check-artists-column-grants

BEGIN;

REVOKE SELECT ON TABLE "public"."artists" FROM "anon", "authenticated";

GRANT SELECT (
  "id",
  "name",
  "name_search",
  "pronoun_id",
  "labels",
  "directory_status",
  "duplicate_of",
  "profile_image_url",
  "profile_image_source",
  "profile_image_fetched_at",
  "booking_info",
  "management_info",
  "contact_info",
  "deleted",
  "created_at",
  "updated_at"
) ON TABLE "public"."artists" TO "anon", "authenticated";

COMMIT;
