-- Migration: site_stats table + daily approved-artist-count refresh
-- Append this to supabase_schema_current.sql and run against your live
-- Supabase database (SQL Editor). Safe to re-run (idempotent).
--
-- Purpose: keep a cheap, precomputed count of directory ("approved")
-- artists so the homepage reads ONE row instead of counting on every
-- request. The count is rounded to the nearest 100 for display; the
-- exact value is stored alongside for debugging/monitoring.

-- ────────────────────────────────────────────────────────────
-- 1. Generic single-row-per-stat table
-- ────────────────────────────────────────────────────────────
create table if not exists public.site_stats (
  key        text primary key,
  value_int  bigint not null,          -- rounded, display value
  exact_int  bigint,                   -- exact value at last refresh
  updated_at timestamptz not null default now()
);

comment on table public.site_stats is
  'Precomputed site-wide stats for cheap reads (e.g. homepage artist count). Written by refresh_approved_artist_count().';

-- Public (anon) read access; writes go through the service/secret key
-- which bypasses RLS.
alter table public.site_stats enable row level security;

drop policy if exists "Public can read site stats" on public.site_stats;
create policy "Public can read site stats"
  on public.site_stats for select
  using (true);

-- ────────────────────────────────────────────────────────────
-- 2. Refresh function — recomputes the approved-artist count
-- ────────────────────────────────────────────────────────────
-- "Approved" == directory_status = 'approved' AND deleted = false,
-- matching the public directory RLS policy and the partial index
-- idx_artists_name_search_trgm_approved.
--
-- ROUNDING: floor() = round DOWN to nearest 100, so "more than X
-- artists" copy is never an overstatement.
create or replace function public.refresh_approved_artist_count()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  exact_count bigint;
  rounded     bigint;
begin
  select count(*) into exact_count
  from public.artists
  where directory_status = 'approved'
    and deleted = false;

  rounded := floor(exact_count / 100.0) * 100;   -- round down to nearest 100

  insert into public.site_stats (key, value_int, exact_int, updated_at)
  values ('approved_artist_count', rounded, exact_count, now())
  on conflict (key) do update
    set value_int  = excluded.value_int,
        exact_int  = excluded.exact_int,
        updated_at = excluded.updated_at;

  return rounded;
end;
$$;

-- Populate immediately so the row exists right after migration.
select public.refresh_approved_artist_count();

-- ────────────────────────────────────────────────────────────
-- 3. Daily schedule via pg_cron (runs entirely inside Supabase)
-- ────────────────────────────────────────────────────────────
-- Requires the pg_cron extension. On Supabase: Dashboard ->
-- Database -> Extensions -> enable "pg_cron" (or run the create
-- extension line below). If you'd rather schedule this from an
-- external runner (cron/GitHub Action) calling the .mjs script,
-- skip this section.

create extension if not exists pg_cron;

-- Remove any prior copy of this job so re-running is safe.
select cron.unschedule('refresh-approved-artist-count')
where exists (
  select 1 from cron.job where jobname = 'refresh-approved-artist-count'
);

-- Run daily at 04:15 UTC (low-traffic window).
select cron.schedule(
  'refresh-approved-artist-count',
  '15 4 * * *',
  $$ select public.refresh_approved_artist_count(); $$
);
