// ============================================================
// link-url-match.mjs — "do these two URLs point at the same place?"
//
// Extracted from integrate-harvested-links.mjs, which grew this rule while
// comparing a harvested URL against the canonical (already-live, or
// about-to-be-inserted) URL for an (artist, platform) pair. It is the repo's
// definition of link sameness, so anything else deciding whether two
// artist_links rows are the same link uses it too rather than growing a
// fifth slightly-different normaliser.
//
// Ignores formatting differences that don't change where the link points:
//   - http vs https ("http://x.com/a" vs "https://x.com/a")
//   - a trailing slash on either side ("https://x.com/a" vs "https://x.com/a/")
//   - a "www." prefix on either side ("https://instagram.com/a" vs
//     "https://www.instagram.com/a")
//   - hostname case ("Instagram.com" vs "instagram.com")
//   - known tracking/share query params (see TRACKING_PARAMS), e.g.
//     Spotify's "?si=...&nd=1" that gets stripped during normal link
//     cleanup — a harvested URL with these params still counts as matching
//     a live URL without them.
//
// Path case is deliberately PRESERVED. Hostnames are case-insensitive by
// spec; paths are not, and several platforms mint mixed-case profile paths
// (Discogs, Facebook). Folding path case would merge links that genuinely
// differ — the wrong way to be wrong for a caller that deletes rows.
//
// Falls back to a plain string comparison if either value isn't a parseable
// URL, so an unparseable value only ever matches itself.
// ============================================================

const TRACKING_PARAMS = new Set([
  "si", // spotify share id
  "nd", // spotify "new design" flag, seen tacked onto shared links
  "context", // spotify share context
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "igsh", // instagram share id
  "igshid", // instagram share id (older format)
  "fbclid",
  "gclid",
  "feature", // youtube share source
  "pp", // youtube share tracking
]);

/**
 * Canonical comparison form of a URL. Equal outputs mean the same link.
 *
 * @param   {string} rawUrl
 * @returns {string}  normalised URL, or `rawUrl` unchanged if unparseable
 */
export function normalizeForComparison(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param);
    }
    const query = url.searchParams.toString();
    url.search = query ? `?${query}` : "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Do two URLs point at the same place?
 *
 * @param   {string} a
 * @param   {string} b
 * @returns {boolean}
 */
export function urlsMatch(a, b) {
  if (a === b) return true;
  return normalizeForComparison(a) === normalizeForComparison(b);
}
