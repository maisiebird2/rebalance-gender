-- Migration: remove anonymous INSERT access to artists
--
-- Run once in the Supabase SQL editor. Safe to re-run (DROP POLICY IF
-- EXISTS and REVOKE are idempotent, and the whole thing is one
-- transaction).
--
-- Why:
--
--   A 2026-07 security review flagged that the RLS policy "Anyone can
--   submit a pending artist" (INSERT, roles {public}, WITH CHECK
--   directory_status = 'pending') combined with a table-level INSERT
--   grant to anon/authenticated let anyone holding the publishable key
--   (i.e. anyone, it ships in the browser bundle) POST rows directly to
--   /rest/v1/artists — bypassing every protection in /api/submit:
--   Turnstile, the honeypot, email verification, and the duplicate
--   check. The grant was table-level, so every column was writable
--   (notes, contact_info, booking_info, submitted_by_email, ...), not
--   just the ones the submission form uses.
--
--   Nothing uses this path. All app writes to artists go through the
--   service role, which bypasses RLS and grants entirely:
--     - /api/submit and /api/search-miss use getSupabaseAdminClient()
--     - admin and edit server actions use getSupabaseAdminClient()
--     - the browser-side anon client (src/lib/supabase/browser.ts) is
--       only used for auth on the login and reset-password pages
--
--   Fix: drop the policy and revoke the grant. Either alone would stop
--   the writes (RLS with no INSERT policy denies, and no grant denies
--   before RLS is even consulted); doing both keeps the policy list and
--   the ACL each telling the truth on their own.
--
--   TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN are revoked too. They
--   are residue of Supabase's permissive defaults for new tables — not
--   reachable through PostgREST, but the public API roles have no
--   business holding them.
--
-- What is deliberately kept:
--
--   - The SELECT policy "Public can view approved artists" and the
--     column-level SELECT grants from
--     supabase_migration_artists_private_columns.sql. That pair is what
--     serves public directory reads: the column grants control WHICH
--     COLUMNS, the policy controls WHICH ROWS. This migration touches
--     neither.
--   - service_role keeps full access (admin panel, /api/submit,
--     enrichment scripts).
--
-- Caveats to keep in mind after this runs:
--
--   1. Anonymous submissions still work — they never used this path.
--      They go through POST /api/submit, which validates and writes
--      with the service role.
--
--   2. This class of grant will reappear on NEW tables: the database's
--      default privileges (pg_default_acl) still grant ALL to
--      anon/authenticated on every table created by postgres or
--      supabase_admin — that is Supabase's out-of-the-box behavior.
--      RLS-enabled-with-no-policy keeps those grants inert, but any
--      future CREATE POLICY ... FOR INSERT TO public on a new table
--      would reopen a direct write path. Tightening the default
--      privileges is a possible follow-up, left out of scope here.
--
-- Verification: with the publishable key, an insert must now be denied
-- (HTTP 401/403, SQLSTATE 42501 permission denied):
--
--   curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/artists" \
--     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--     -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--     -H "Content-Type: application/json" \
--     -d '{"name":"grant probe","directory_status":"pending"}'
--
-- and a normal submission through the /submit form must still succeed.

BEGIN;

DROP POLICY IF EXISTS "Anyone can submit a pending artist" ON "public"."artists";

REVOKE INSERT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE "public"."artists" FROM "anon", "authenticated";

COMMIT;
