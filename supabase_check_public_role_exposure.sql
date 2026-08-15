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
--   The second entry is Supabase's stock default and is the residual hole. The
--   statement that would close it is:
--
--     ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
--       REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
--       FROM anon, authenticated;
--
--   We cannot run it. ALTER DEFAULT PRIVILEGES FOR ROLE <r> requires membership
--   in <r>; supabase_admin is the platform superuser and `postgres` is neither a
--   superuser nor a member of it (pg_has_role('postgres','supabase_admin',
--   'MEMBER') = false, checked 2026-07-31). Running it as postgres fails with
--   "permission denied to change default privileges". Only Supabase can change
--   it — worth a support request if you want it closed at the platform level;
--   quote the ALTER above and the pg_has_role result.
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
-- Expected as of 2026-07-31: 15 rows, all SELECT-only —
--   artist_aliases, artist_bandcamp_albums, artist_enrichment, artist_genres,
--   artist_images, artist_labels, artist_links, artist_locations,
--   artist_similarity_scores, biographies, genres, platforms, pronouns,
--   site_content, site_stats
-- ANY true in the ins/upd/del columns is a finding: no anonymous write path is
-- meant to exist, since all app writes go through the service role. The first
-- run of this file (2026-07-31) turned up exactly one — artist_labels granted
-- INSERT/UPDATE/DELETE to authenticated, removed by
-- supabase_migration_artist_labels_revoke_writes.sql.
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
