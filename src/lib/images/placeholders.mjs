// ============================================================
// The one registry of "this isn't a real profile photo" patterns.
//
// Several platforms answer "no photo" with a generic silhouette rather
// than a 404, so a naive fetch happily stores a grey blob. Every source
// that acquires or audits an image checks against this list, and a
// match is treated as no image at all (IMAGE_FAILURE_STATUS.PLACEHOLDER).
//
// This knowledge used to live in three places that had to be kept in
// sync by hand: PLACEHOLDER_IMAGE_PATTERNS in the scrape lib,
// isDefaultAvatarUrl in scripts/lib/soundcloud.mjs, and a copy of the
// first inside prune-placeholder-images.mjs. The copies existed because
// the lib is bundled into Next while the scripts are plain Node — the
// same boundary this .mjs + .d.mts pair crosses for failures.mjs.
//
// Match on the stable hash or filename, never the full URL, so every
// size variant and CDN host of the same placeholder is caught.
//
// See scripts/IMAGE-HARVESTING-PLAN.md (Phase 1).
// ============================================================

/**
 * @typedef {object} PlaceholderPattern
 * @property {string|null} platform  Platform this applies to, or null for any.
 * @property {RegExp} pattern
 * @property {string} label  Human-readable, used in failure detail text.
 */

/** @type {readonly PlaceholderPattern[]} */
const PLACEHOLDER_PATTERNS = Object.freeze([
  {
    // https://lastfm.freetls.fastly.net/i/u/ar0/2a96cbd8b46e442fc41c2b86b821562f.jpg
    // — the same hash is served at every size variant (ar0/174s/300x300/…).
    platform: "lastfm",
    pattern: /2a96cbd8b46e442fc41c2b86b821562f/i,
    label: "Last.fm default star avatar",
  },
  {
    // The SoundCloud API still returns an avatar_url for accounts with no
    // photo: a grey placeholder at .../images/default_avatar_<size>.png.
    // Real avatars are avatars-<id>-<size>.jpg and never contain it.
    platform: "soundcloud",
    pattern: /\/default_avatar[_.]/i,
    label: "SoundCloud default grey avatar",
  },
]);

/**
 * Patterns that apply when checking a URL for `platform`: the universal
 * ones plus that platform's own. Passing no platform checks against
 * every pattern — what the cleanup scripts want when sweeping stored
 * rows whose platform they are iterating separately.
 */
function applicablePatterns(platform) {
  return PLACEHOLDER_PATTERNS.filter(
    (p) => p.platform === null || platform === undefined || p.platform === platform
  );
}

/**
 * True when this URL is a known platform placeholder rather than a real
 * profile photo.
 *
 * @param {unknown} imageUrl
 * @param {string} [platform] Narrow to one platform's patterns.
 */
export function isPlaceholderImageUrl(imageUrl, platform) {
  if (typeof imageUrl !== "string" || imageUrl === "") return false;
  return applicablePatterns(platform).some((p) => p.pattern.test(imageUrl));
}

/**
 * The matching pattern's label, or null. Lets a caller say *which*
 * placeholder it rejected instead of just that it rejected one.
 *
 * @param {unknown} imageUrl
 * @param {string} [platform]
 * @returns {string|null}
 */
export function describePlaceholderImageUrl(imageUrl, platform) {
  if (typeof imageUrl !== "string" || imageUrl === "") return null;
  return applicablePatterns(platform).find((p) => p.pattern.test(imageUrl))?.label ?? null;
}
