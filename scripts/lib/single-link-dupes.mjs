// ============================================================
// single-link-dupes.mjs — pure selection logic for
// soft-delete-single-link-dupes.mjs.
//
// The rule, in one sentence: an artist whose ONLY link is a link a live
// approved artist already holds is a leftover stub — the approved row carries
// the same platform association plus everything else, so the stub can be
// soft-deleted.
//
// "Only a <platform> link" means the artist has exactly one artist_links row
// and it is on that platform. An artist with a HÖR link *and* a SoundCloud
// link is not a bare stub: soft-deleting it would lose the other link, so it
// never qualifies. An artist with no links at all has nothing to share and is
// never considered.
//
// Runs across every platform by default. Passing `platform` narrows the
// candidates to stubs on that one platform — the approved sharer is always
// matched on the SAME platform either way, so a Bandcamp link never justifies
// deleting a SoundCloud stub.
//
// When the stub is ITSELF approved, both rows are live directory entries and
// the question becomes which one to keep. That is settled by link count, not
// by status:
//
//   - a sharer holds more links -> the sharer is the fuller entry, so the
//     one-link row is the duplicate and is soft-deleted. This is the case
//     the script exists to clear: two of the same artist showing on the
//     public site, one of them a bare stub.
//   - every approved sharer also holds just the one link -> a genuine tie,
//     nothing to choose between them. Flagged for a human, never guessed.
//
// DB-free so it can be unit-tested; the reads and the update live in the
// script. See scripts/lib/hoer-db.mjs for the counterpart.
// ============================================================

import { normalizeForComparison } from "./link-url-match.mjs";

// Audit-CSV column order. Shared with the script so the file and the
// selection can't drift apart.
export const SOFT_DELETE_AUDIT_COLUMNS = [
  "artist_id",
  "name",
  "directory_status",
  "platform",
  "url",
  "link_count",
  "approved_artist_id",
  "approved_artist_name",
  "approved_artist_url",
  "approved_artist_link_count",
  "action",
  "note",
];

/**
 * Grouping key for "the same link on the same platform".
 *
 * Platform is part of the key on purpose: two rows are only the same link if
 * they are the same platform's link. URL sameness itself is the repo-wide
 * rule from link-url-match.mjs (scheme / www / trailing-slash / tracking-param
 * insensitive).
 *
 * @param   {string} platform
 * @param   {string | null | undefined} url
 * @returns {string | null}  null when there is no url to key on
 */
export function linkKey(platform, url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  return `${platform}\n${normalizeForComparison(trimmed)}`;
}

/**
 * Decide which artists to soft-delete.
 *
 * @param {object} input
 * @param {Array<{artist_id: string, platform: string, url: string|null}>} input.links
 *        Every artist_links row, all platforms — the other-platform rows are
 *        what prove an artist is *not* a single-link stub, so they can never
 *        be filtered out before this point.
 * @param {Map<string, {id: string, name: string, directory_status: string, deleted: boolean}>} input.artists
 *        id -> artist row, for every artist referenced by `links`.
 * @param {string | null} [input.platform]
 *        Restrict candidates to stubs on this platform; null/undefined runs
 *        across all of them.
 *
 * @returns {{ toSoftDelete: string[], audit: object[] }}
 *          `toSoftDelete` is the artist ids to update; `audit` has one row per
 *          artist considered (soft-deleted and skipped alike), CSV-shaped.
 */
export function selectSingleLinkDupeSoftDeletes({ links, artists, platform = null }) {
  // artist_id -> { total, sole }. `sole` is the row itself when the artist has
  // exactly one link, so a stub is `total === 1`.
  const linkSummary = new Map();
  for (const link of links) {
    let entry = linkSummary.get(link.artist_id);
    if (!entry) {
      entry = { total: 0, sole: null };
      linkSummary.set(link.artist_id, entry);
    }
    entry.total += 1;
    entry.sole = entry.total === 1 ? link : null;
  }

  const linkCountOf = (artistId) => linkSummary.get(artistId)?.total ?? 0;

  // link key -> the live approved artists holding it. Built from EVERY link an
  // approved artist has, not just their sole one: an approved artist with ten
  // links still justifies deleting a stub that duplicates one of them.
  // Soft-deleted rows are excluded — a deleted row is not a survivor, so it
  // cannot justify deleting anything else.
  const approvedByKey = new Map();
  for (const link of links) {
    const artist = artists.get(link.artist_id);
    if (!artist || artist.deleted || artist.directory_status !== "approved") continue;
    const key = linkKey(link.platform, link.url);
    if (!key) continue;
    let holders = approvedByKey.get(key);
    if (!holders) {
      holders = new Map(); // artist_id -> holder, deduped
      approvedByKey.set(key, holders);
    }
    // One artist can hold two rows that normalise to the same link (an http
    // and an https copy, say). Count them as the one sharer they are.
    if (!holders.has(artist.id)) {
      holders.set(artist.id, { ...artist, url: link.url, linkCount: linkCountOf(artist.id) });
    }
  }

  const toSoftDelete = [];
  const audit = [];

  // Stable order so two runs over the same data produce the same CSV.
  const candidateIds = [...linkSummary.keys()].sort();

  for (const artistId of candidateIds) {
    const { total, sole } = linkSummary.get(artistId);

    // Condition 1: exactly one link, on the platform under consideration.
    if (total !== 1) continue;
    if (platform !== null && sole.platform !== platform) continue;

    const key = linkKey(sole.platform, sole.url);
    if (!key) continue;

    // Condition 2: a *different* live approved artist holds the same link.
    const approved = [...(approvedByKey.get(key)?.values() ?? [])].filter(
      (a) => a.id !== artistId
    );
    if (approved.length === 0) continue;

    const artist = artists.get(artistId);
    const record = (action, note) => {
      audit.push({
        artist_id: artistId,
        name: artist?.name ?? "",
        directory_status: artist?.directory_status ?? "",
        platform: sole.platform,
        url: sole.url,
        link_count: total,
        approved_artist_id: approved.map((a) => a.id).join("; "),
        approved_artist_name: approved.map((a) => a.name).join("; "),
        approved_artist_url: approved.map((a) => a.url).join("; "),
        approved_artist_link_count: approved.map((a) => a.linkCount).join("; "),
        action,
        note,
      });
    };

    if (!artist) {
      record("skipped", "artist row not found for this link (orphaned link?)");
      continue;
    }
    if (artist.deleted) {
      record("skipped", "already soft-deleted");
      continue;
    }

    // Both rows live on the public site. Keep the fuller one: a sharer with
    // more links is the real entry and this one is the stub beside it. Only a
    // dead heat — every approved sharer as bare as this row — needs a human.
    if (artist.directory_status === "approved") {
      const fuller = approved.filter((a) => a.linkCount > total);
      if (fuller.length === 0) {
        record(
          "skipped",
          "approved, and every approved artist sharing this link has just the " +
            "one link too — nothing to choose between them; pick a survivor by hand"
        );
        continue;
      }
      toSoftDelete.push(artistId);
      record(
        "to-soft-delete",
        "approved, but this row holds only the one link and an approved sharer " +
          `holds more: ${fuller.map((a) => `${a.name} (${a.linkCount} links)`).join("; ")}`
      );
      continue;
    }

    toSoftDelete.push(artistId);
    record("to-soft-delete", "");
  }

  return { toSoftDelete, audit };
}
