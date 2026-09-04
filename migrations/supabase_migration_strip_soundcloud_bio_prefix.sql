-- Strip the "SoundCloud bio: " prefix out of artist_enrichment.bio and
-- artist_enrichment.bio_sanitized.
--
-- Context: sync-soundcloud.mjs (Phase 2a) and the legacy enrich-bios.mjs both
-- wrote the bio as `SoundCloud bio: ${bio}`, so the label ended up inside the
-- stored string rather than in the UI. Both the artist page sidebar and the
-- edit form's "Bio (SoundCloud)" field render that string verbatim, under a
-- heading that already reads "SoundCloud bio" — so the prefix showed up as the
-- first words of the bio text itself.
--
-- Both writers stopped emitting the prefix in the same change as this
-- migration, so a later 2a run won't put it back.
--
-- Only artist_enrichment is affected. biographies (platform = 'soundcloud')
-- and artist_harvested_bios have always stored the bio unprefixed — platform
-- is its own column there — so nothing in either table changes.
--
-- Safe to re-run: the pattern is anchored to the start of the string and
-- matched case-sensitively, so a second pass matches nothing.

-- 1) Preview affected rows first.
SELECT id, artist_id, platform,
       left(bio, 80)           AS bio_head,
       left(bio_sanitized, 80) AS bio_sanitized_head
FROM artist_enrichment
WHERE bio LIKE 'SoundCloud bio:%'
   OR bio_sanitized LIKE 'SoundCloud bio:%'
ORDER BY id;

-- 2) Run the fix.
--
-- Each column is guarded by its own CASE so a row whose prefix sits in only
-- one of the two columns leaves the other untouched.
--
-- bio_sanitized gets a second pass for leading <br> tags: sanitizeBio()
-- converts newlines to <br>, so a bio stored as "SoundCloud bio: \nreal text"
-- sanitized to "SoundCloud bio: <br>real text". Removing just the prefix there
-- would leave the row opening on a blank line.
--
-- NULLIF collapses a bio that was nothing but the prefix to NULL rather than
-- an empty string, which is what every reader already treats as "no bio".
UPDATE artist_enrichment
SET
  bio = CASE
          WHEN bio LIKE 'SoundCloud bio:%'
          THEN NULLIF(
                 regexp_replace(bio, '^(SoundCloud bio:[[:space:]]*)+', ''),
                 ''
               )
          ELSE bio
        END,
  bio_sanitized = CASE
          WHEN bio_sanitized LIKE 'SoundCloud bio:%'
          THEN NULLIF(
                 regexp_replace(
                   regexp_replace(bio_sanitized, '^(SoundCloud bio:[[:space:]]*)+', ''),
                   '^(<br[[:space:]]*/?>[[:space:]]*)+', ''
                 ),
                 ''
               )
          ELSE bio_sanitized
        END
WHERE bio LIKE 'SoundCloud bio:%'
   OR bio_sanitized LIKE 'SoundCloud bio:%';

-- 3) Confirm nothing is left prefixed — this should return 0.
SELECT count(*) AS rows_still_prefixed
FROM artist_enrichment
WHERE bio LIKE 'SoundCloud bio:%'
   OR bio_sanitized LIKE 'SoundCloud bio:%';

-- 4) Spot-check a sample of the cleaned rows.
SELECT id, artist_id, platform,
       left(bio, 80)           AS bio_head,
       left(bio_sanitized, 80) AS bio_sanitized_head
FROM artist_enrichment
WHERE platform = 'soundcloud'
  AND bio IS NOT NULL
ORDER BY id
LIMIT 20;
