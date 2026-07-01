-- Migration: add mb_gender to artists, add songkick + tidal platforms
-- Append this to supabase_schema.sql and run against your live Supabase database.

-- 1. New column on artists to store gender as returned by MusicBrainz
--    (e.g. 'Female', 'Male', 'Non-binary'). Kept separate from any
--    user-editable field so it's always clearly MB-sourced.
alter table artists
  add column if not exists gender_mb text;

-- 2. Two new profile-link platforms
insert into platforms (key, label, sort_order) values
  ('songkick', 'Songkick', 110),
  ('tidal',    'Tidal',    120)
on conflict (key) do nothing;
