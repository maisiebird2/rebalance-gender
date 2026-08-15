-- Artists that were enriched by enrich-soundcloud.mjs (Phase 2a) BEFORE state
-- tracking moved from enrich-soundcloud-cache.json into resolved_artists, and so
-- were never recorded in the current system. These are the "already processed"
-- artists that the latest run does NOT count in its "110 already processed" total.
--
-- "Already enriched" = an artist_enrichment row with platform = 'soundcloud' and
-- external_id NOT NULL (the SoundCloud numeric user id, set on every successful
-- resolve) — the same criterion backfill-resolved-soundcloud-enrich.mjs uses.
-- "Not marked" = no resolved_artists row for service = 'soundcloud-enrich'.
--
-- Running backfill-resolved-soundcloud-enrich.mjs writes exactly these rows.
-- (Needs the resolved_artists grants migration applied first — see
-- supabase_migration_resolved_artists_grants.sql.)

-- ── 1. Headline count: how many processed-but-unmarked artists exist ──────────
SELECT count(*) AS enriched_but_unmarked
FROM artist_enrichment ae
LEFT JOIN resolved_artists ra
  ON ra.artist_id = ae.artist_id
  AND ra.service = 'soundcloud-enrich'
WHERE ae.platform = 'soundcloud'
  AND ae.external_id IS NOT NULL
  AND ra.artist_id IS NULL;

-- ── 2. The list, newest enrichment first ──────────────────────────────────────
-- last_synced_at is when the artist was actually enriched, so it distinguishes
-- these older, pre-switch rows from the 110 marked the new way.
SELECT
  ae.artist_id,
  a.name,
  ae.external_id,
  ae.follower_count,
  ae.track_count,
  ae.last_synced_at
FROM artist_enrichment ae
JOIN artists a ON a.id = ae.artist_id
LEFT JOIN resolved_artists ra
  ON ra.artist_id = ae.artist_id
  AND ra.service = 'soundcloud-enrich'
WHERE ae.platform = 'soundcloud'
  AND ae.external_id IS NOT NULL
  AND ra.artist_id IS NULL
ORDER BY ae.last_synced_at DESC NULLS LAST;

-- ── 3. Sanity check: reconcile the totals ─────────────────────────────────────
-- enriched_total should ≈ marked_total (110) + enriched_but_unmarked.
SELECT
  (SELECT count(*) FROM artist_enrichment
     WHERE platform = 'soundcloud' AND external_id IS NOT NULL)        AS enriched_total,
  (SELECT count(*) FROM resolved_artists
     WHERE service = 'soundcloud-enrich')                             AS marked_total;
