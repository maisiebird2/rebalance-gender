// ============================================================
// Pure, DB-free matching logic for Phase D (integrate-hoer-artists.mjs).
//
// Deterministic and side-effect-free → unit-tested (hoer-match.test.mjs). The
// script owns the DB reads/writes and the URL normalization; this module owns
// which of a term's staged socials are eligible to match on, and how a set of
// matched artists resolves to a bind / seed / ambiguous outcome.
// ============================================================

// Identity-bearing platforms whose links reliably identify one artist. A match
// on any of these is trustworthy. Deliberately excludes:
//   • 'other'    — generic by definition.
//   • 'youtube'  — HÖR set videos are not an artist-channel signal (also
//                  already dropped by CLASSIFY_CONFIGS.hoer upstream).
//   • 'linktree' — an aggregator, sometimes a collective/label; a false bind is
//                  worse than a duplicate here.
export const MATCH_POOL_PLATFORMS = new Set([
  "soundcloud",
  "instagram",
  "bandcamp",
  "resident_advisor",
  "discogs",
  "spotify",
]);

// A URL identifies an artist only if it has a real path segment — a handle or
// id. A bare host (`https://bandcamp.com/`, `https://soundcloud.com/`) or a
// malformed link would otherwise match every artist carrying the same junk, so
// it must NOT be a match key. Returns false for unparseable input.
export function hasMeaningfulPath(parsedUrl) {
  let path;
  try {
    path = new URL(String(parsedUrl)).pathname;
  } catch {
    return false;
  }
  return path.replace(/\/+$/, "").length > 0;
}

// Filter a term's staged links to those eligible to match on: pool platform AND
// a meaningful path. Input rows are hoer_term_links shape
// ({ parsed_platform, parsed_url, ... }); returns the same rows, filtered.
export function eligibleMatchLinks(links) {
  return (Array.isArray(links) ? links : []).filter(
    (l) => MATCH_POOL_PLATFORMS.has(l.parsed_platform) && hasMeaningfulPath(l.parsed_url)
  );
}

// Resolve the set of artist ids a term's eligible links matched to, into an
// outcome:
//   0 distinct → { type: 'seed' }               (new pending artist)
//   1 distinct → { type: 'bind', artistId }     (bind to the existing artist)
//  >1 distinct → { type: 'ambiguous', artistIds } (leave for the dedup process)
export function decideOutcome(matchedArtistIds) {
  const distinct = [...new Set(matchedArtistIds)];
  if (distinct.length === 0) return { type: "seed" };
  if (distinct.length === 1) return { type: "bind", artistId: distinct[0] };
  return { type: "ambiguous", artistIds: distinct };
}
