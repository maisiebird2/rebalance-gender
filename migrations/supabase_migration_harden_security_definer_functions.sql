-- Migration: harden the two SECURITY DEFINER functions in public
--
-- Run once in the Supabase SQL editor. Safe to re-run (REVOKE, GRANT and
-- ALTER FUNCTION ... SET are all idempotent, and the whole thing is one
-- transaction).
--
-- Both functions run SECURITY DEFINER — with the privileges of their owner
-- (postgres) rather than the caller — which is what makes their grants and
-- their search_path worth being deliberate about. Two separate issues, found
-- during the security review of 2026-08-01:
--
-- ── 1. refresh_approved_artist_count() was executable by anyone ──────────────
--
--   The function had a NULL ACL, which in Postgres does not mean "no
--   privileges" — it means the built-in default, and for functions that
--   default is EXECUTE to PUBLIC. So any caller holding the publishable key
--   could invoke it over PostgREST:
--
--     POST /rest/v1/rpc/refresh_approved_artist_count
--
--   Two consequences. It runs `count(*)` over the whole artists table and
--   writes site_stats, so an anonymous caller could force unbounded repeat
--   table scans — cheap for them, not for the database. And it refreshes
--   site_stats.exact_int, which is readable by anon, defeating the rounding
--   the function itself performs: value_int is deliberately floored to the
--   nearest 100 for public display (see supabase_migration_site_stats.sql),
--   while exact_int sits beside it holding the precise figure.
--
--   Note this migration does NOT change who can read site_stats. If the exact
--   count is meant to stay private, exact_int needs a column grant of its own
--   — the artists table pattern, see supabase_migration_artists_private_
--   columns.sql. Flagged, not assumed.
--
-- ── 2. upsert_submitter_email(text) had no pinned search_path ───────────────
--
--   A SECURITY DEFINER function without `SET search_path` resolves unqualified
--   names using the CALLER's search_path. The body references bare
--   `submitter_emails`, so a caller able to create a same-named object earlier
--   in their own search_path would have the function write there instead,
--   while running as postgres.
--
--   This was NOT exploitable: EXECUTE is granted only to postgres and
--   service_role, and anon/authenticated hold USAGE but not CREATE on public,
--   so no object-shadowing path existed. It is the standard hardening gap and
--   a Supabase linter warning ("function_search_path_mutable"); fix it while
--   we are here rather than leave it depending on those two facts staying true.
--
--   `SET search_path = public` matches what refresh_approved_artist_count()
--   already does, and preserves current behaviour: the function only ever
--   touches public.submitter_emails.
--
-- What is deliberately kept:
--
--   service_role keeps EXECUTE on refresh_approved_artist_count(). It is
--   granted explicitly below because revoking from PUBLIC materialises the ACL
--   as owner-only, and an implicit privilege would silently disappear. This
--   mirrors upsert_submitter_email, which is already {postgres, service_role},
--   and leaves a server-only path open for a manual refresh. service_role
--   bypasses RLS anyway, so this concedes nothing.
--
--   postgres keeps EXECUTE as the function's owner — owner privileges survive
--   REVOKE ... FROM PUBLIC and reappear in the ACL as postgres=X/postgres.
--   This matters: see the caller note below.
--
-- Callers — read before applying:
--
--   The live caller is a pg_cron job, not application code.
--   supabase_migration_site_stats.sql schedules 'refresh-approved-artist-count'
--   daily at 04:15 UTC running `select public.refresh_approved_artist_count();`.
--   It is demonstrably running: site_stats.updated_at reads 04:15:00 UTC.
--
--   pg_cron executes each job as the role that scheduled it. That migration is
--   applied by hand in the Supabase SQL editor, which connects as postgres —
--   the function's owner — so the job keeps EXECUTE through owner privileges
--   and this change does not affect it. That could not be verified directly
--   from here: reading cron.job requires privileges the review connection
--   (schema_reader) does not have. Hence the post-apply check below.
--
--   If the job WERE scheduled as some other role, the failure is small and
--   loud in the right place: the daily refresh stops, site_stats goes stale,
--   and the homepage count freezes at its last value. Nothing breaks for
--   visitors. Recovery is either `npm run update-artist-count` (which does not
--   use this function at all — it counts and upserts site_stats directly with
--   the service key) or granting EXECUTE to the role cron actually uses.
--
--   No application code calls this function. scripts/update-artist-count.mjs
--   does the same work independently via the service key.
--
-- Verification, after applying:
--
--   1. Both ACLs should now read {postgres=X/postgres,service_role=X/postgres},
--      and both functions should show a pinned search_path:
--
--        select p.proname,
--               coalesce(p.proacl::text, 'NULL (= PUBLIC EXECUTE)') as acl,
--               coalesce(p.proconfig::text, 'no search_path')       as config
--        from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.prosecdef;
--
--   2. An anonymous RPC call should now be refused. With the publishable key:
--
--        POST /rest/v1/rpc/refresh_approved_artist_count
--        -> expect 401/403 with code 42501, permission denied
--
--   3. Confirm the cron job still runs: after the next 04:15 UTC window,
--      site_stats.updated_at should have advanced to that day. This is the
--      check that closes the uncertainty noted above — worth actually looking
--      the following day rather than assuming.

BEGIN;

-- 1. Stop anonymous execution of the stats refresh.
REVOKE EXECUTE ON FUNCTION "public"."refresh_approved_artist_count"()
  FROM PUBLIC, "anon", "authenticated";

-- Re-grant the server-only path explicitly (see "What is deliberately kept").
GRANT EXECUTE ON FUNCTION "public"."refresh_approved_artist_count"()
  TO "service_role";

-- 2. Pin the search_path on the remaining unpinned SECURITY DEFINER function.
ALTER FUNCTION "public"."upsert_submitter_email"(text)
  SET search_path = public;

COMMIT;
