// ============================================================
// Shared vocabulary for image-acquisition failures.
//
// Every source that tries to obtain a profile image for a platform —
// the SoundCloud API path in sync-soundcloud.mjs, the scrape path in
// src/lib/scrape-images.ts — records its failures here under one service
// key per platform:
//
//     image:<platform>
//
// One row per (artist_id, service), so "why does this artist have no
// picture from this platform?" is a single lookup with a single answer,
// whichever source produced it. Before this, the same fact could live
// under 'image-enrich:<platform>', 'image-sync:<platform>' or
// 'soundcloud-sync' depending on which code path got there first.
//
// NOT covered by this vocabulary: 'image-store:<platform>', written by
// store-images.mjs. That is a downstream re-hosting failure for an image
// already acquired — a different concern, and folding it in here would
// collide on the (artist_id, service) primary key.
//
// Plain .mjs rather than .ts so both plain-node scripts and the TS/Next
// side can import it; types live alongside in failures.d.mts.
//
// See scripts/IMAGE-HARVESTING-PLAN.md (Phase 0).
// ============================================================

export const IMAGE_FAILURE_SERVICE_PREFIX = "image:";

/** harvest_failures.service value for one platform's image acquisition. */
export function imageFailureService(platform) {
  return `${IMAGE_FAILURE_SERVICE_PREFIX}${platform}`;
}

/** Inverse of imageFailureService(); null for any other service key. */
export function platformFromImageFailureService(service) {
  return service.startsWith(IMAGE_FAILURE_SERVICE_PREFIX)
    ? service.slice(IMAGE_FAILURE_SERVICE_PREFIX.length)
    : null;
}

/**
 * The complete set of image-acquisition failure statuses.
 *
 * Split deliberately finer than "did we get an image": NO_IMAGE means the
 * source affirmatively says this artist has no photo, while NO_IMAGE_TAG
 * means we found nothing to read at all. Those look identical in a
 * coverage count but mean opposite things — a spike in NO_IMAGE_TAG for a
 * platform that normally yields photos is how a broken scrape announces
 * itself, and collapsing the two is what let YouTube return nothing for
 * every artist without anyone noticing.
 */
export const IMAGE_FAILURE_STATUS = Object.freeze({
  /** Source says this artist has no photo (empty og:image, no avatar). */
  NO_IMAGE: "no_image",
  /** Nothing to read: no og:image/twitter:image tag anywhere on the page. */
  NO_IMAGE_TAG: "no_image_tag",
  /** A known platform-default placeholder was served instead of a photo. */
  PLACEHOLDER: "placeholder",
  /**
   * The link cannot yield an image and won't start to on its own: a 4xx,
   * a dead profile, or a URL that isn't a valid profile for this platform
   * at all. Fixing it needs a corrected link, not another fetch.
   */
  UNREACHABLE: "unreachable",
  /** Network error, timeout or 5xx — presumed temporary. */
  FETCH_FAILED: "fetch_failed",
  /** Acquisition worked; persisting it didn't. */
  WRITE_FAILED: "write_failed",
});

// Definitive: we know the answer, so don't spend another fetch on it
// without --force. NO_IMAGE_TAG is definitive to preserve the existing
// skip-on-retry behaviour, but it is the one worth watching: if a
// platform's scrape breaks, this is the status that fills up, and
// reclassifying it as transient is the lever to auto-heal such a run.
const DEFINITIVE_STATUSES = new Set([
  IMAGE_FAILURE_STATUS.NO_IMAGE,
  IMAGE_FAILURE_STATUS.NO_IMAGE_TAG,
  IMAGE_FAILURE_STATUS.PLACEHOLDER,
  IMAGE_FAILURE_STATUS.UNREACHABLE,
]);

// Transient: unknown rather than absent. Always retried, and the only
// thing that makes a dedicated-harvester platform eligible for a scrape
// fallback (see scrape-images.ts).
const TRANSIENT_STATUSES = new Set([
  IMAGE_FAILURE_STATUS.FETCH_FAILED,
  IMAGE_FAILURE_STATUS.WRITE_FAILED,
]);

export function isDefinitiveImageFailure(status) {
  return DEFINITIVE_STATUSES.has(status);
}

export function isTransientImageFailure(status) {
  return TRANSIENT_STATUSES.has(status);
}

/**
 * Service keys used for image acquisition before this vocabulary existed.
 * harvest_failures was empty when the change landed, so there is nothing
 * to migrate — these are kept only so cleanup paths (prune-artist-images)
 * still sweep any row written by an older checkout.
 */
export const LEGACY_IMAGE_FAILURE_SERVICE_PREFIXES = Object.freeze([
  "image-enrich:",
  "image-sync:",
]);
