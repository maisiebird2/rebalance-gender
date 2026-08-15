-- Artists that still need to be processed by build-soundcloud-follow-graph.mjs.
-- These are approved, non-deleted artists with a SoundCloud link who have
-- either no artist_enrichment row yet, or one where both follow_graph_built_at
-- and sync_error are NULL (i.e. neither successfully processed nor recorded
-- as a dead link).

SELECT
  a.name,
  al.url,
  ae.follow_graph_built_at,
  ae.sync_error
FROM artist_links al
JOIN artists a ON a.id = al.artist_id
LEFT JOIN artist_enrichment ae
  ON ae.artist_id = al.artist_id AND ae.platform = 'soundcloud'
WHERE al.platform = 'soundcloud'
  AND a.directory_status = 'approved'
  AND a.deleted = false
  AND ae.follow_graph_built_at IS NULL
  AND ae.sync_error IS NULL
ORDER BY a.name;
