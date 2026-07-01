-- Indexes needed for build-soundcloud-follow-graph.mjs startup queries.
-- Without these, fetching all SoundCloud URLs from artist_links does a full
-- table scan — slow enough to hit Supabase's statement timeout once the
-- table grows large (hundreds of thousands of sc_followee rows).

-- Speeds up: fetchAllSoundCloudUrlMap (SELECT ... WHERE platform = 'soundcloud')
CREATE INDEX IF NOT EXISTS idx_artist_links_platform
  ON artist_links (platform);

-- Speeds up: fetchProcessedArtistIds (SELECT ... WHERE platform = 'soundcloud'
--   AND (follow_graph_built_at IS NOT NULL OR sync_error IS NOT NULL))
CREATE INDEX IF NOT EXISTS idx_artist_enrichment_platform
  ON artist_enrichment (platform);
