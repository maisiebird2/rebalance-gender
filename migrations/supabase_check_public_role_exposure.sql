-- Check: what the public API roles (anon, authenticated) can actually reach in
-- schema public. Read-only — run in the Supabase SQL editor whenever a new
-- table appears, an extension is installed, or a policy/grant is changed.
--
-- Why this file exists (the thing it stands in for):
--
--   Default privileges in schema public are set per CREATING ROLE, and the two
--   entries disagree:
--
--     created by postgres        anon/authenticated get Dxtm
--                                (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) —
--                                no SELECT/INSERT/UPDATE/DELETE, so a new table
--                                is unreachable through PostgREST. This is the
--                                role the SQL editor and the CLI connect as, so
--                                it governs every table we create.
--
--     created by supabase_admin  anon/authenticated get arwdDxtm — EVERYTHING,
--                                including SELECT and INSERT.
--
--   The second entry is Supabase's stock default and is the residual hole.
--
--   ⛔️ NOTHING IN THIS FILE IS A STEP TO RUN AGAINST THE HOLE. The statement
--   that would close it is reproduced below as TEXT TO SEND TO SUPABASE
--   SUPPORT — it is not a migration, not a TODO, and it cannot succeed from
--   this project. Every executable statement in this file is a read-only
--   SELECT, starting at query 1.
--
--   Quote this to support (do not paste it into the SQL editor):
--
--     | ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
--     |   REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
--     |   FROM anon, authenticated;
--
--   Why it cannot succeed here: ALTER DEFAULT PRIVILEGES FOR ROLE <r> requires
--   membership in <r>. supabase_admin is the platform superuser, and `postgres`
--   — the role the SQL editor connects as — is neither a superuser
--   (rolsuper = false) nor a member of it
--   (pg_has_role('postgres','supabase_admin','MEMBER') = false, checked
--   2026-07-31). The best it can return is "permission denied to change
--   default privileges".
--
--   It was tried once anyway, on 2026-07-31: the SQL editor sat on "running…"
--   indefinitely, while the database showed no postgres backend, no active
--   query, and zero ungranted locks. Nothing was changed, nothing was stuck,
--   and nothing needed cancelling — the tab was simply closed. Expect that
--   dead end rather than a clean error, which is the other reason this is
--   marked do-not-run.
--
--   In the meantime the exposure is conditional, not live: it only bites if a
--   relation in public is created BY supabase_admin, and as of 2026-07-31 all 37
--   relations there are owned by postgres. The realistic way one appears is
--   installing an extension into public — Supabase's UI defaults to the
--   `extensions` schema instead, whose default ACL grants anon nothing. So:
--   watch for it rather than fix it, which is what query 2 below is for.
--
-- If a check trips, note that we may not be able to clean up either: REVOKE has
-- to come from the grantor, so privileges granted by supabase_admin on a
-- supabase_admin-owned table cannot be revoked by postgres. That case is a
-- support request, not a migration.
--
-- Related: supabase_migration_artists_private_columns.sql (column-level SELECT
-- grants on artists) and supabase_migration_artists_revoke_anon_insert.sql
-- (removed the anon INSERT path into the moderation queue).

-- ── 1. The default privileges themselves, by creating role ───────────────────
-- Expected: exactly two rows for public — postgres with anon/authenticated on
-- Dxtm, and supabase_admin with anon/authenticated on arwdDxtm. If the postgres
-- row ever gains r (SELECT) or a (INSERT) for anon, new tables start out
-- publicly reachable and that IS a live problem.
SELECT
  defaclrole::regrole                    AS creating_role,
  defaclnamespace::regnamespace          AS schema,
  defaclacl                              AS default_acl
FROM pg_default_acl
WHERE defaclobjtype = 'r'
  AND defaclnamespace = 'public'::regnamespace
ORDER BY creating_role;

-- ── 2. Relations in public NOT owned by postgres ─────────────────────────────
-- Expected: zero rows. Any row here was created by another role (supabase_admin
-- via an extension or platform action) and therefore picked up the permissive
-- default privileges above — inspect it with query 3 immediately.
SELECT
  c.relname,
  c.relkind,
  pg_get_userbyid(c.relowner) AS owner,
  c.relrowsecurity            AS rls_enabled,
  c.relacl
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND pg_get_userbyid(c.relowner) <> 'postgres'
ORDER BY c.relname;

-- ── 3. Everything anon can actually read or write, table-level ───────────────
-- THE INVARIANT, not the row count: every row must be SELECT-only. ANY true in
-- an ins/upd/del column is a finding — no anonymous or logged-in write path is
-- meant to exist, since all app writes go through the service role. The row
-- count itself grows legitimately as public-facing tables are added, so don't
-- treat a change in it as the signal; read the write columns.
--
-- The first run (2026-07-31) turned up exactly one violation: artist_labels
-- granted INSERT/UPDATE/DELETE to authenticated, removed by
-- supabase_migration_artist_labels_revoke_writes.sql.
--
-- Snapshot for orientation — 17 tables, all SELECT-only, 2026-07-31:
--   artist_aliases, artist_bandcamp_albums, artist_enrichment, artist_genres,
--   artist_images, artist_labels, artist_links, artist_locations,
--   artist_similarity_scores, artist_type_assignments, artist_types,
--   biographies, genres, platforms, pronouns, site_content, site_stats
-- Note `artists` is deliberately absent here — its table-level SELECT was
-- replaced by column-level grants, which query 4 covers.
SELECT
  c.relname,
  has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
  has_table_privilege('anon', c.oid, 'INSERT') AS anon_insert,
  has_table_privilege('anon', c.oid, 'UPDATE') AS anon_update,
  has_table_privilege('anon', c.oid, 'DELETE') AS anon_delete,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (
    has_table_privilege('anon', c.oid, 'SELECT')
    OR has_table_privilege('anon', c.oid, 'INSERT')
    OR has_table_privilege('anon', c.oid, 'UPDATE')
    OR has_table_privilege('anon', c.oid, 'DELETE')
    OR has_table_privilege('authenticated', c.oid, 'INSERT')
    OR has_table_privilege('authenticated', c.oid, 'UPDATE')
    OR has_table_privilege('authenticated', c.oid, 'DELETE')
  )
ORDER BY c.relname;

-- ── 4. Column-level grants (the artists private-columns arrangement) ─────────
-- Expected: 17 columns on artists and nothing else. The private ones must NOT
-- appear: notes, submitted_by_email, submitted_at, reviewed_at, gender_mb.
-- A new artists column is private by default — it shows up here only if someone
-- granted it explicitly.
SELECT
  c.relname,
  a.attname,
  a.attacl
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relnamespace = 'public'::regnamespace
  AND a.attacl IS NOT NULL
ORDER BY c.relname, a.attnum;

-- ── 5. Write-capable policies visible to the public roles ────────────────────
-- Expected: zero rows. RLS policies only matter once a grant exists, but a
-- permissive INSERT/UPDATE/DELETE policy on {public} is exactly what turned a
-- stale grant into a live write path on artists — catch the next one early.
SELECT
  tablename,
  policyname,
  cmd,
  roles,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  AND (roles = '{public}' OR roles && '{anon,authenticated}')
ORDER BY tablename, policyname;

-- ── 6. SECURITY DEFINER functions, and who may execute them ──────────────────
-- TWO INVARIANTS, both per row:
--   a. anon_execute and auth_execute must both be false. A SECURITY DEFINER
--      function runs as its OWNER, so letting a public role call one hands them
--      postgres's privileges for the duration — RLS and grants alike stop
--      applying inside the body.
--   b. settings must show a search_path. Without one, unqualified names in the
--      body resolve through the CALLER's search_path, which is the standard
--      privilege-escalation shape for a definer function.
--
-- Watch the ACL column for NULL. A NULL proacl does not mean "no privileges" —
-- it means the Postgres default, and for functions that default is EXECUTE to
-- PUBLIC. That is not visible as a grant anywhere, which is exactly how
-- refresh_approved_artist_count() sat anon-callable without appearing in any
-- grant listing until the 2026-08-01 review read the catalog directly.
--
-- Non-definer functions are deliberately excluded: they run as the caller, so
-- anon executing one reaches nothing anon could not already reach, and the
-- pg_trgm/unaccent extension functions would swamp the output. The residual
-- risk there is cost, not privilege — an expensive function callable by anyone
-- is a DoS question. If that ever matters, widen the WHERE clause to drop the
-- prosecdef test and read the result with that in mind.
--
-- Snapshot after supabase_migration_harden_security_definer_functions.sql
-- (2026-08-01) — two rows, both compliant:
--   refresh_approved_artist_count()  {postgres,service_role}  search_path=public
--   upsert_submitter_email(text)     {postgres,service_role}  search_path=public
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid)                  AS args,
  has_function_privilege('anon', p.oid, 'EXECUTE')           AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')  AS auth_execute,
  COALESCE(array_to_string(p.proconfig, ', '), '⚠ no search_path') AS settings,
  COALESCE(p.proacl::text, '⚠ NULL (= EXECUTE to PUBLIC)')   AS acl,
  pg_get_userbyid(p.proowner)                                AS owner
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
ORDER BY p.proname;
