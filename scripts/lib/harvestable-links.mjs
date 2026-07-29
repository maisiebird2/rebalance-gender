// ============================================================
// Shared "harvestable" filter for the platform harvesters'
// artist_links queries (sync-soundcloud / -bandcamp / -discogs /
// -linktree).
//
// Two kinds of artist_links rows must never reach a harvester:
//
//   - url IS NULL — there is nothing to fetch. The column is nullable,
//     and a NULL once reached sync-bandcamp's syncArtist, which does
//     string surgery on the URL before its try/catch-protected guard
//     runs (stripBandcampWww → rawUrl.replace on null) — crashing the
//     stage and, under the orchestrator, the whole run. The other
//     harvesters survive a NULL but do the wrong thing with it:
//     SoundCloud/Linktree record a pointless wrong-field failure, and
//     Discogs falls through to its old-format name-resolution path and
//     would write a URL *guessed from the artist's name* back into
//     artist_links.
//   - not_found = TRUE — a human explicitly marked this platform "no
//     profile exists" for the artist (these rows also carry url NULL
//     today, but filter on the flag in its own right: it's a human
//     adjudication, so fetching is guaranteed wasted work that would
//     pollute harvest_failures with cases already decided).
//
// Applied by every harvester's link loader so the definition of
// "harvestable" can't drift per platform.
// ============================================================

export function onlyHarvestableLinks(query) {
  return query.not("url", "is", null).eq("not_found", false);
}
