-- Migration: add 'not_electronic' and 'label_etc' values to the artist_status enum.
-- Run against your live Supabase database.
--
-- Like 'obscure', artists with these statuses are hidden from the public
-- interface. No display change is needed: every public-facing query filters on
-- directory_status = 'approved', so they fall out automatically. The values let
-- admins record *why* an artist is out of the directory — 'not_electronic' for
-- artists outside electronic music, 'label_etc' for labels, collectives, radio
-- stations and similar non-artist entities.

alter type public.artist_status add value if not exists 'not_electronic';
alter type public.artist_status add value if not exists 'label_etc';
