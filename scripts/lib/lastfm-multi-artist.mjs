// Detection of Last.fm "more than one artist with this name" disambiguation
// pages, used by scripts/prune-lastfm-multi-artist.mjs.
//
// Why this exists: Last.fm data feeds the recommendation engine's parameters.
// When a Last.fm page actually covers several different acts sharing a name,
// its bio/tags/listeners blend them together, so the link is dropped rather
// than kept as ambiguous input.
//
// The patterns below were derived by harvesting every Last.fm bio in our own
// data and reading the real phrasings — not guessed. The notices are
// user-contributed, so the wording varies widely in three places:
//   quantifier — "more than one", "several", "multiple", "at least two", "FOUR", "at least 2"
//   verb       — "There is/are", "There appear to be", "There seems"
//   joiner     — "with this name", "called X", "under the alias", "who record
//                under the name", "that go by the name", "sharing this name"
// Rather than enumerate phrasings, these match the *shape* of the notice.

export const MULTI_ARTIST_PATTERNS = [
  // The canonical notice, in all its variants:
  //   "There is more than one artist with this name"
  //   "There are several artists under the alias 1111"
  //   "There are at least two known artists with this name"
  //   "There are at least 3 artists sharing this name"
  //   "There are FOUR artists with the same name"
  //   "There appear to be two artists called AMS"
  //   "there seems at least two artists with the same name"
  //   "There are several bands/artists releasing music under the name Svarog"
  //   "There are various artists, called 'Boo' or BOO!"
  //   "There is 3 bands named 747" / "There are at least 21 bands by this name"
  //   "There are two acts under name Acyl"
  //   "There are at least 6 known projects going by the name FM"
  // Numbers are matched as digits (\d+) or words, so "at least 21 bands" and
  // "There are 5 artists named Adriana" both land. The {0,2} slot allows an
  // adjective between quantifier and noun ("known", "different", "separate").
  //
  // The noun list is kept tight (artist/band/act/project) on purpose: broader
  // nouns pull in ordinary bio prose ("several competitions", "various
  // genres", "multiple recitals"), all of which must stay unmatched.
  /there\s+(?:is|are|appears?\s+to\s+be|seems?\s+to\s+be|seems?)\s+(?:at\s+least\s+)?(?:more\s+than\s+one|several|multiple|various|a\s+few|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:\w+\s+){0,2}?(?:artists?|bands?|acts?|projects?)\b/i,
  // "Weaver is the name of more than one artist", "Aida is the name of several artists"
  /\bis\s+the\s+name\s+of\s+(?:more\s+than\s+one|several|multiple|at\s+least|two|three|four)\b/i,
  // "There is also another artist by the name of BOO from Tokyo"
  /there\s+is\s+(?:also\s+)?another\s+(?:artist|band)\s+(?:by|with|called|named|under)\b/i,
  // Typos that appear verbatim in real Last.fm bios:
  /there\s+is\s+one\s+than\s+one\s+artist/i,   // "There is one than one artist with this name" (Acolytes)
  /\bthe\s+are\s+multiple\s+artists\b/i,       // "The are multiple artists that have recorded as 4D" (4D)
]

// Pull the bio text out of an artist.getInfo payload. `content` is the full
// text and `summary` a truncated copy; either can carry the notice, so both
// are searched.
export function bioText(payload) {
  const bio = payload?.artist?.bio ?? {}
  return `${bio.content ?? ''}\n${bio.summary ?? ''}`
}

// Returns the source of the first matching pattern, or null if the text shows
// no multi-artist notice.
//
// NOTE on what is deliberately NOT matched — these are verified false
// positives from our own data, all legitimate single-artist bios:
//   • "not to be confused with the actress of the same name"  (Andrea Parker)
//   • "…has contributed to production for other artists"      (A$AP Rocky)
//   • "They have also remixed other artists"                  (ADULT.)
//   • "launch a label of the same name"                       (Adana Twins)
// Bare "same name" / "other artists" are not reliable signals on their own.
// Keep any new pattern anchored to the disambiguation boilerplate.
export function matchMultiArtist(text) {
  for (const re of MULTI_ARTIST_PATTERNS) {
    if (re.test(text)) return re.source
  }
  return null
}
