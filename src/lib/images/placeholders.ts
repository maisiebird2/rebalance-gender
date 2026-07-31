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
// the lib is bundled into Next while the scripts were plain Node; the
// scripts now run under tsx and import this directly.
//
// Match on the stable hash or filename, never the full URL, so every
// size variant and CDN host of the same placeholder is caught.
//
// See scripts/IMAGE-HARVESTING-PLAN.md (Phase 1).
// ============================================================

interface PlaceholderPattern {
  /** Platform this applies to, or null for any. */
  platform: string | null;
  pattern: RegExp;
  /** Human-readable, used in failure detail text. */
  label: string;
}

// Last.fm's default star avatar used to head this list. It was removed
// along with the rest of the Last.fm data (see
// supabase_migration_remove_lastfm_data.sql): Last.fm is no longer an
// image candidate in PLATFORM_PRIORITY, so no code path can reach a
// Last.fm URL to check, and every stored Last.fm image has been deleted.
const PLACEHOLDER_PATTERNS: readonly PlaceholderPattern[] = [
  {
    // The SoundCloud API still returns an avatar_url for accounts with no
    // photo: a grey placeholder at .../images/default_avatar_<size>.png.
    // Real avatars are avatars-<id>-<size>.jpg and never contain it.
    platform: "soundcloud",
    pattern: /\/default_avatar[_.]/i,
    label: "SoundCloud default grey avatar",
  },
  {
    // Qobuz artist pages with no photo emit the Qobuz logo as og:image,
    // e.g. https://static-www.qobuz.com/img/qobuz_logo_dark.svg. Match the
    // filename stem so light/dark and format variants are all caught.
    platform: "qobuz",
    pattern: /qobuz_logo/i,
    label: "Qobuz logo",
  },
];

/**
 * Patterns that apply when checking a URL for `platform`: the universal
 * ones plus that platform's own. Passing no platform checks against
 * every pattern — what the cleanup scripts want when sweeping stored
 * rows whose platform they are iterating separately.
 */
function applicablePatterns(platform: string | undefined): readonly PlaceholderPattern[] {
  return PLACEHOLDER_PATTERNS.filter(
    (p) => p.platform === null || platform === undefined || p.platform === platform
  );
}

/**
 * True when this URL is a known platform placeholder rather than a real
 * profile photo. Pass `platform` to narrow to that platform's patterns.
 */
export function isPlaceholderImageUrl(imageUrl: unknown, platform?: string): boolean {
  if (typeof imageUrl !== "string" || imageUrl === "") return false;
  return applicablePatterns(platform).some((p) => p.pattern.test(imageUrl));
}

/**
 * The matching pattern's label, or null. Lets a caller say *which*
 * placeholder it rejected instead of just that it rejected one.
 */
export function describePlaceholderImageUrl(
  imageUrl: unknown,
  platform?: string
): string | null {
  if (typeof imageUrl !== "string" || imageUrl === "") return null;
  return applicablePatterns(platform).find((p) => p.pattern.test(imageUrl))?.label ?? null;
}
