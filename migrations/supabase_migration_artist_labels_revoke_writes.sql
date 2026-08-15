-- Migration: remove the leftover write grants on artist_labels
--
-- Run once in the Supabase SQL editor. Safe to re-run (REVOKE is idempotent,
-- and the whole thing is one transaction).
--
-- Why:
--
--   artist_labels was the one table in public still handing write privileges to
--   a public API role:
--
--     anon=rDxtm            SELECT + the harmless residue
--     authenticated=arwdDxtm  SELECT, INSERT, UPDATE, DELETE + residue
--
--   Found on 2026-07-31 by supabase_check_public_role_exposure.sql, while
--   checking a different question. Every other table in public grants the
--   public roles SELECT at most.
--
--   This is NOT currently exploitable: artist_labels has RLS enabled and only a
--   SELECT policy ("Public can view labels of approved artists"), so writes are
--   denied no matter what the grants say. It is the same latent shape that made
--   the artists issue live, though — a grant sitting idle until someone adds a
--   permissive policy, at which point it becomes a write path without anyone
--   revisiting the grant. Remove the grant instead of relying on the absence of
--   a policy.
--
--   Whether `authenticated` is reachable by the public depends on the project's
--   auth signup settings; the grant is unnecessary either way.
--
--   Nothing uses these privileges. All writes to artist_labels go through the
--   service role: /api/submit (src/app/api/submit/route.ts), the admin panel
--   (src/app/admin/actions.ts), and the edit form
--   (src/app/artist/[id]/edit/actions.ts) all use getSupabaseAdminClient().
--
-- What is deliberately kept:
--
--   SELECT for anon and authenticated — public artist pages render labels
--   through the "Public can view labels of approved artists" policy, for
--   signed-out and signed-in visitors alike. service_role is untouched.
--
-- Verification: supabase_check_public_role_exposure.sql, query 3 — after this
-- runs, all 15 rows should show SELECT only, with every insert/update/delete
-- column false.

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE "public"."artist_labels" FROM "anon", "authenticated";

COMMIT;
