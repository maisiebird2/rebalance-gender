// Parsing for the edit form's "Duplicate of" field, which accepts an artist
// id typed/pasted directly or a pasted artist-page URL. Kept separate from the
// server action so it can be unit tested and reused by both the on-blur check
// and the save path.

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Pull an artist id out of whatever was entered: a bare UUID, or any URL
 * containing one (`/artist/<id>`, `/artist/<id>/edit`, with or without host,
 * query string, or trailing slash — all real shapes of a copied address bar).
 *
 * Returns the lowercased id, or null when the input holds no UUID at all.
 * Whether that id exists is a database question, answered separately by
 * resolveDuplicateTarget().
 */
export function parseArtistIdInput(raw: string): string | null {
  const match = raw.trim().match(UUID_RE);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Outcome of checking an entered "Duplicate of" value against the database.
 * Lives here rather than in the server-action module because a "use server"
 * file may only export async functions.
 */
export type DuplicateTargetResult =
  | { ok: true; id: string; name: string }
  | { ok: false; error: string };
