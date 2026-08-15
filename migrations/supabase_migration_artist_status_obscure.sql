-- Migration: add 'obscure' value to the artist_status enum.
-- Run against your live Supabase database.
--
-- Artists with directory_status = 'obscure' are intentionally hidden from the
-- public interface. No display change is needed: every public-facing query
-- filters on directory_status = 'approved', so 'obscure' artists fall out
-- automatically. This value simply lets admins mark an artist as hidden
-- without rejecting or deleting it.

alter type public.artist_status add value if not exists 'obscure';
