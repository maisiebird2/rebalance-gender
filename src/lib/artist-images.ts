// Picks which of an artist's stored images (artist_images — see
// supabase_migration_artist_images.sql) to display, for callers that
// have already fetched the artist's `images` array (queries.ts,
// discover/route.ts).
//
// Rotation strategy: deterministic, seeded by artist_id + today's
// date (UTC), not a denormalized "current pick" column and not
// fully-random-per-page-load. This was a deliberate choice (see
// scripts/PIPELINE.md, "Multi-image artist_images table"):
//   - Stable within a day, so a page rendered more than once (or
//     hydrated client-side after SSR) never shows a different image
//     on the same visit — no flicker, no hydration mismatch.
//   - Rotates once a day automatically, with zero cron job, zero
//     extra DB writes, and zero extra state to keep consistent.
//   - The trade-off: two different artists' pages don't reshuffle
//     independently within the same day, and a visitor who reloads
//     tomorrow sees a (likely) different image — both accepted as
//     fine for a "some variety over time" profile picture, not a
//     strict fairness guarantee.

export interface ArtistImageSource {
  storage_url: string | null;
  source_url: string;
}

/**
 * Deterministic 32-bit string hash (FNV-1a). Not cryptographic — just
 * needs to spread artist_id+date pairs roughly evenly across
 * `images.length` buckets.
 */
function hashString(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Pick one display URL from an artist's stored images. Prefers the
 * re-hosted Storage URL (storage_url); falls back to the original
 * source_url when store-images.mjs hasn't re-hosted that row yet, so
 * an image shows up immediately rather than waiting on the next
 * re-hosting run. Returns null when there are no images.
 */
export function pickArtistImage(
  artistId: string,
  images: readonly ArtistImageSource[] | null | undefined,
  date: Date = new Date()
): string | null {
  if (!images || images.length === 0) return null;
  const dateKey = date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const index = hashString(`${artistId}:${dateKey}`) % images.length;
  const chosen = images[index];
  return chosen.storage_url ?? chosen.source_url ?? null;
}
