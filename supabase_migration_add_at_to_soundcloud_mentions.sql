-- Add back the "@" before existing SoundCloud @mention links in
-- artist_enrichment.bio_sanitized.
--
-- Context: the linkifier (src/lib/sanitize-bio.ts + scripts/linkify-bios.mjs)
-- used to consume the "@" into the match without re-emitting it, so
-- "Daddy at @osare-editions" became:
--   Daddy at <a href="https://soundcloud.com/osare-editions" ...>osare-editions</a>
-- It should have become:
--   Daddy at @<a href="https://soundcloud.com/osare-editions" ...>osare-editions</a>
--
-- This migration fixes already-linkified rows to match. It only targets
-- anchors that look like mention-generated links (href slug equals the
-- lowercased link text, with the exact target/rel attributes the
-- linkifier always adds) and skips any that already have "@" in front,
-- so it's safe to re-run.

-- 1) Preview affected rows first.
SELECT id, artist_id, platform, bio_sanitized
FROM artist_enrichment
WHERE bio_sanitized ~ '<a href="https://soundcloud\.com/[a-z0-9_-]+" target="_blank" rel="noopener noreferrer">[A-Za-z0-9_-]+</a>';

-- 2) Run the fix.
DO $$
DECLARE
  rec RECORD;
  match_arr TEXT[];
  slug TEXT;
  link_text TEXT;
  old_tag TEXT;
  new_bio TEXT;
  changed BOOLEAN;
BEGIN
  FOR rec IN
    SELECT id, bio_sanitized
    FROM artist_enrichment
    WHERE bio_sanitized ~ '<a href="https://soundcloud\.com/[a-z0-9_-]+" target="_blank" rel="noopener noreferrer">[A-Za-z0-9_-]+</a>'
  LOOP
    new_bio := rec.bio_sanitized;
    changed := FALSE;

    FOR match_arr IN
      SELECT regexp_matches(
        rec.bio_sanitized,
        '<a href="https://soundcloud\.com/([a-z0-9_-]+)" target="_blank" rel="noopener noreferrer">([A-Za-z0-9_-]+)</a>',
        'g'
      )
    LOOP
      slug := match_arr[1];
      link_text := match_arr[2];

      -- Only treat it as a mention link if the visible text, lowercased,
      -- matches the href slug -- that's the shape the linkifier produces.
      CONTINUE WHEN lower(link_text) <> slug;

      old_tag := '<a href="https://soundcloud.com/' || slug ||
                 '" target="_blank" rel="noopener noreferrer">' || link_text || '</a>';

      -- Idempotency guard: skip if this exact tag is already preceded by "@".
      CONTINUE WHEN position('@' || old_tag IN new_bio) > 0;

      new_bio := replace(new_bio, old_tag, '@' || old_tag);
      changed := TRUE;
    END LOOP;

    IF changed THEN
      UPDATE artist_enrichment
      SET bio_sanitized = new_bio
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- 3) Spot-check the result.
SELECT id, artist_id, platform, bio_sanitized
FROM artist_enrichment
WHERE bio_sanitized LIKE '%@<a href="https://soundcloud.com/%';
