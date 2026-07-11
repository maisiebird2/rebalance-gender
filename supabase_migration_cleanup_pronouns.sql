-- Migration: clean up the pronouns table
-- Run against your live Supabase database (SQL Editor).
--
-- Two fixes, both guarding the artists.pronoun_id foreign key
-- (artists_pronoun_id_fkey has no ON DELETE clause, so it is RESTRICT:
-- a pronouns row cannot be deleted while any artist still points at it).
--
--   1. Delete the junk entry "whang" (id = 10). Any artist mistakenly
--      tagged with it is cleared to NULL first (whang is not a real
--      pronoun, so there is nothing to remap it to).
--
--   2. De-duplicate "they/them" vs "they / them". The spaced variant is
--      the duplicate; every artist on it is repointed to the canonical
--      "they/them" row, then the duplicate row is deleted.
--
-- Values in pronouns.value are stored lowercased + trimmed (see
-- src/app/api/submit/route.ts and src/app/admin/actions.ts), so the two
-- they/them rows differ only by the spaces around the slash.
--
-- Safe to re-run: after a successful run the preview counts go to zero and
-- the DELETEs match nothing.

-- ════════════════════════════════════════════════════════════
-- 1. PREVIEW (read-only) — run this block first, change nothing
-- ════════════════════════════════════════════════════════════

-- 1a. Confirm id 10 really is "whang", and see the canonical vs dup rows.
select id, value
from public.pronouns
where id = 10
   or value in ('they/them', 'they / them')
order by id;

-- 1b. How many artists reference each of the rows we are about to touch.
select p.id, p.value, count(a.id) as artist_count
from public.pronouns p
left join public.artists a on a.pronoun_id = p.id
where p.id = 10
   or p.value in ('they/them', 'they / them')
group by p.id, p.value
order by p.id;


-- ════════════════════════════════════════════════════════════
-- 2. APPLY (writes) — run inside a transaction so you can bail out
-- ════════════════════════════════════════════════════════════
begin;

-- ── 2a. "whang" (id 10) ─────────────────────────────────────
-- Clear any artist tagged with the junk value, then drop the row.
-- Guarded by value so we never delete the wrong id if 10 has been reused.
update public.artists
set pronoun_id = null
where pronoun_id = 10;

delete from public.pronouns
where id = 10
  and value = 'whang';

-- ── 2b. Merge "they / them" → "they/them" ───────────────────
-- Repoint artists off the spaced duplicate onto the canonical row...
update public.artists a
set pronoun_id = canon.id
from public.pronouns canon, public.pronouns dup
where canon.value = 'they/them'
  and dup.value   = 'they / them'
  and a.pronoun_id = dup.id;

-- ...then remove the now-unreferenced duplicate.
delete from public.pronouns
where value = 'they / them';

-- ── 2c. Verify before committing ────────────────────────────
-- Expect: no 'whang', no 'they / them', exactly one 'they/them',
-- and zero artists still pointing at a deleted row (the anti-join
-- below should return no rows).
select id, value
from public.pronouns
where id = 10
   or value in ('they/them', 'they / them')
order by id;

select a.id
from public.artists a
left join public.pronouns p on p.id = a.pronoun_id
where a.pronoun_id is not null
  and p.id is null;

-- If both look right:
commit;
-- Otherwise:
-- rollback;
