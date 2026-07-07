-- Migration: site_content table — editable, singleton text blocks
-- (e.g. the public /about page) managed from the admin panel.
-- Append this to supabase_schema_current.sql and run against your live
-- Supabase database (SQL Editor). Safe to re-run (idempotent).
--
-- Reads are public (anon) so pages like /about can render the copy;
-- writes go through the service/secret key (admin panel) which bypasses
-- RLS. Mirrors the grants/policies on site_stats.

-- ────────────────────────────────────────────────────────────
-- 1. Generic single-row-per-key content table
-- ────────────────────────────────────────────────────────────
create table if not exists public.site_content (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);

comment on table public.site_content is
  'Editable site-wide text blocks (e.g. the /about page), managed from the admin panel. Plain text; blank lines separate paragraphs.';

alter table public.site_content enable row level security;

drop policy if exists "Public can read site content" on public.site_content;
create policy "Public can read site content"
  on public.site_content for select
  using (true);

-- Table-level SELECT grant for anon/authenticated (matches site_stats;
-- without it the RLS policy above returns no rows for the anon key).
grant select on table public.site_content to anon, authenticated;

-- The admin panel writes through the secret key (service_role). Tables
-- created in the SQL editor don't always grant write privileges to
-- service_role automatically, so grant them explicitly (idempotent).
-- Without this, saving from /admin/about fails with
-- "permission denied for table site_content".
grant select, insert, update, delete on table public.site_content to service_role;

-- ────────────────────────────────────────────────────────────
-- 2. Seed the About page with starter copy (only if absent)
-- ────────────────────────────────────────────────────────────
insert into public.site_content (key, value)
values (
  'about',
  E'<p>Rebalance Gender is a directory of women and gender-expansive producers and DJs in electronic music.</p>\n<p>Our goal is to make it easier to discover, book, and celebrate artists who have historically been under-represented on lineups and in studios.</p>\n<p>Edit this text anytime from the admin panel — you can use HTML.</p>'
)
on conflict (key) do nothing;
