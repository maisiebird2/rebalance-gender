// ============================================================
// hoer-links.mjs — shared HÖR link-migration logic.
//
// When an exact-duplicate HÖR artist is resolved to a surviving directory
// artist, its platform='hoer' link is COPIED onto the survivor (a new
// artist_links row; the duplicate keeps its own as a record). This module
// holds the pure decision + the insert-row shape so both the integrated
// resolver (resolve-hoer-status.mjs) and the standalone backlog importer
// (migrate-hoer-dupe-links.mjs) behave identically.
//
// DB-free so it can be unit-tested; the actual insert stays in the scripts.
// ============================================================

export const HOER = "hoer";

// Audit-CSV column order, shared by every caller that writes a link-migration
// log so the files are interchangeable.
export const HOER_LINK_AUDIT_COLUMNS = [
  "artist_id",
  "hoer_name",
  "matched_artist_id",
  "matched_name",
  "action",
  "url",
  "note",
];

// Decide what to do with one duplicate's hoer link, given the url already
// destined for (or present on) the surviving artist.
//
//   survivorUrl == null/undefined -> survivor has no hoer link yet -> copy
//   survivorUrl === srcUrl        -> same link already there       -> skip
//   survivorUrl !== srcUrl        -> a different link is there      -> conflict
//
// The (artist_id, platform) unique constraint permits only ONE hoer link per
// artist, so a different existing link is a genuine collision for a human, not
// something to force.
export function decideHoerLinkCopy(srcUrl, survivorUrl) {
  const src = srcUrl ?? "";
  if (survivorUrl === null || survivorUrl === undefined) {
    return { action: "copy", note: "" };
  }
  if (survivorUrl === src) {
    return { action: "skip", note: "survivor already has this hoer link" };
  }
  return {
    action: "conflict",
    note: `survivor already has a different hoer link ("${survivorUrl}") — ` +
      "one hoer link per artist; resolve by hand",
  };
}

// The artist_links insert payload for copying a source link onto `artistId`.
// Preserves handle / original_url / not_found so the survivor's link is a
// faithful copy of the duplicate's.
export function buildHoerLinkRow(artistId, srcLink) {
  return {
    artist_id: artistId,
    platform: HOER,
    handle: srcLink?.handle ?? null,
    url: srcLink?.url ?? null,
    original_url: srcLink?.original_url ?? null,
    not_found: srcLink?.not_found ?? false,
  };
}
