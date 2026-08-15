// ============================================================
// Discogs profile-image write — the Discogs analog of the avatar
// handling baked into sync-soundcloud.mjs.
//
// The Discogs API's GET /artists/{id} response already carries an
// `images` array; sync-discogs.mjs fetches that response for every
// concern (links, aliases, bio, ...) and caches the whole payload to
// api_response_cache. So obtaining a Discogs image is not a separate
// API call — it's extracting a field the sync already has in hand and
// writing it to artist_images, exactly the way sync-soundcloud extracts
// avatar_url. See documentation/IMAGE-HARVESTING-PLAN.md and
// src/lib/scrape-images.ts (which now treats discogs as
// OWNED_BY_DEDICATED_HARVESTER, i.e. this module owns its image and the
// og:image scrape stays out of the way).
//
// This logic lives in one place, called by two callers:
//   - sync-discogs.mjs        — inline, from the freshly-fetched payload.
//   - backfill-discogs-images.mjs — from the cached payloads, so already
//     -synced artists get images with zero new API calls.
//
// Rules mirror sync-soundcloud's "Image handling" section:
//   - Directory-only: only approved artists get an image written or a
//     failure recorded. Non-directory artists are left untouched (there
//     are ~100x as many, and their images are never displayed).
//   - "No real image" is recorded, not silently skipped: an artist with
//     an empty/absent `images` array is a NO_IMAGE result under the
//     shared image failure vocabulary (service = 'image:discogs'), keyed
//     to the profile URL, so a later run doesn't re-attempt it until the
//     link changes. Unlike SoundCloud, Discogs doesn't serve a generic
//     placeholder in the array — no photo simply means no entries — so
//     there's no placeholder case to detect.
//   - On a successful write, the image failure row is cleared.
// ============================================================

import { IMAGE_FAILURE_STATUS, imageFailureService } from "../../src/lib/images/failures.js";
import { recordFailure, clearFailure } from "./harvest-failures.mjs";

// harvest_failures.service for the Discogs image concern. Shared across
// every source that acquires an image for this platform (this module and
// a scrape fallback), so "why is there no Discogs picture?" is one lookup.
export const DISCOGS_IMAGE_SERVICE = imageFailureService("discogs");

/**
 * Choose the best profile-image URL from a Discogs artist payload's
 * `images` array, or null if there isn't one.
 *
 * Discogs marks the main artist photo `type: "primary"`; everything else
 * is `"secondary"`. Prefer the primary, fall back to the first entry, and
 * use the full-size `uri` (not the 150px `uri150` thumbnail).
 *
 * @param {unknown} images  the payload's `images` field (may be missing).
 * @returns {string|null}
 */
export function pickDiscogsImageUrl(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const primary = images.find((img) => img && img.type === "primary");
  const chosen = primary ?? images[0];
  const uri = typeof chosen?.uri === "string" ? chosen.uri.trim() : "";
  return uri || null;
}

/**
 * Write (or decline to write) a Discogs profile image for one artist,
 * recording the outcome in harvest_failures under 'image:discogs' the
 * same way sync-soundcloud does for 'image:soundcloud'.
 *
 * @param {object} params
 * @param {import("@supabase/supabase-js").SupabaseClient} params.supabase
 * @param {string}  params.artistId
 * @param {string}  params.discogsUrl  the artist's Discogs profile URL —
 *   stored as source_page_url and used to key the image failure, so the
 *   link-changed cross-check retries automatically when it's corrected.
 * @param {unknown} params.images      the payload's `images` array.
 * @param {boolean} params.isApproved  directory_status === 'approved'.
 * @param {boolean} [params.dryRun]    log-only; no DB writes.
 * @returns {Promise<"stored"|"no_image"|"failed"|"not_approved">}
 */
export async function writeDiscogsImage({ supabase, artistId, discogsUrl, images, isApproved, dryRun = false }) {
  // Directory-only, unconditionally — non-directory artists get neither
  // an image nor a recorded failure (nothing displays their picture).
  if (!isApproved) return "not_approved";

  const imageUrl = pickDiscogsImageUrl(images);

  if (!imageUrl) {
    // Discogs affirmatively has no photo for this artist. Record it so
    // the image pass stops re-checking until the link changes (the same
    // URL-keyed trade-off sync-soundcloud makes for no_avatar).
    if (!dryRun) {
      await recordFailure(supabase, {
        artistId,
        service: DISCOGS_IMAGE_SERVICE,
        status: IMAGE_FAILURE_STATUS.NO_IMAGE,
        detail: "discogs artist has no images",
        url: discogsUrl,
      });
    }
    return "no_image";
  }

  if (dryRun) return "stored";

  const { error } = await supabase.from("artist_images").upsert(
    {
      artist_id: artistId,
      platform: "discogs",
      source_url: imageUrl,
      source_page_url: discogsUrl,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "artist_id,platform" }
  );

  if (error) {
    await recordFailure(supabase, {
      artistId,
      service: DISCOGS_IMAGE_SERVICE,
      status: IMAGE_FAILURE_STATUS.WRITE_FAILED,
      detail: `artist_images upsert failed: ${error.message}`,
      url: discogsUrl,
    });
    return "failed";
  }

  await clearFailure(supabase, { artistId, service: DISCOGS_IMAGE_SERVICE });
  return "stored";
}
