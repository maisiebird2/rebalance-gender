// ============================================================
// single-link-dupes.mjs — pure selection logic for
// soft-delete-single-link-dupes.mjs.
//
// The rule, in one sentence: an artist whose ONLY link is a link another live
// artist already holds is a leftover stub, provided that other row is the
// better of the two — it carries the same platform association and more
// besides, so the stub can be soft-deleted.
//
// "Only a <platform> link" means the artist has exactly one artist_links row
// and it is on that platform. An artist with a HÖR link *and* a SoundCloud
// link is not a bare stub: soft-deleting it would lose the other link, so it
// never qualifies. An artist with no links at all has nothing to share and is
// never considered.
//
// Runs across every platform by default. Passing `platform` narrows the
// candidates to stubs on that one platform — the sharer is always matched on
// the SAME platform either way, so a Bandcamp link never justifies deleting a
// SoundCloud stub.
//
// WHICH ROW SURVIVES is a dominance test on two things: whether the row is
// approved, and how many links it holds. A sharer justifies deleting the
// candidate when it is at least as good on both and strictly better on at
// least one:
//
//   sharer approved, candidate not         -> delete; a directory entry beats
//                                             a row that isn't in the
//                                             directory, whatever its links
//   same status tier, sharer holds more    -> delete; the fuller row is the
//                                             real entry and this is the stub
//                                             beside it
//
// Status alone is not enough, and link count alone is not enough. An approved
// row holding one link is NOT deleted for a not_eligible row holding six:
// the approved row is the only one of the pair the public site shows, so
// deleting it would drop the artist from the directory altogether while the
// fuller data sits on a row nobody can see. That is a merge, not a delete,
// and it is flagged rather than guessed.
//
// Flagged for a human, never guessed:
//   - an exact tie: same status tier, both holding just the one link
//   - the incomparable pair above: candidate approved, sharer fuller but not
//
// A candidate that beats every sharer outright is simply kept, silently — it
// is the survivor, not a problem.
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
  "sharer_id",
  "sharer_name",
  "sharer_status",
  "sharer_url",
  "sharer_link_count",
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

// The two things that decide which row of a duplicate pair survives. Being in
// the directory outranks not being in it; holding more links outranks holding
// fewer. Neither alone is decisive — see the header.
const rank = (row) => ({
  approved: row.directory_status === "approved" ? 1 : 0,
  links: row.linkCount,
});

/**
 * Does `a` beat `b` outright — at least as good on both counts, strictly
 * better on at least one?
 */
function dominates(a, b) {
  const x = rank(a);
  const y = rank(b);
  return (
    x.approved >= y.approved &&
    x.links >= y.links &&
    (x.approved > y.approved || x.links > y.links)
  );
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
 *          artist deleted or flagged, CSV-shaped.
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

  // link key -> every LIVE artist holding it, whatever their status. Built
  // from all of an artist's links, not just a sole one: a row with ten links
  // still justifies deleting a stub duplicating one of them. Soft-deleted
  // rows are excluded — a deleted row is not a survivor, so it cannot justify
  // deleting anything else.
  const holdersByKey = new Map();
  for (const link of links) {
    const artist = artists.get(link.artist_id);
    if (!artist || artist.deleted) continue;
    const key = linkKey(link.platform, link.url);
    if (!key) continue;
    let holders = holdersByKey.get(key);
    if (!holders) {
      holders = new Map(); // artist_id -> holder, deduped
      holdersByKey.set(key, holders);
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

    // Condition 2: a *different* live artist holds the same link.
    const sharers = [...(holdersByKey.get(key)?.values() ?? [])].filter((s) => s.id !== artistId);
    if (sharers.length === 0) continue;

    const artist = artists.get(artistId);
    const record = (action, note, subjects = sharers) => {
      audit.push({
        artist_id: artistId,
        name: artist?.name ?? "",
        directory_status: artist?.directory_status ?? "",
        platform: sole.platform,
        url: sole.url,
        link_count: total,
        sharer_id: subjects.map((s) => s.id).join("; "),
        sharer_name: subjects.map((s) => s.name).join("; "),
        sharer_status: subjects.map((s) => s.directory_status).join("; "),
        sharer_url: subjects.map((s) => s.url).join("; "),
        sharer_link_count: subjects.map((s) => s.linkCount).join("; "),
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

    const self = { ...artist, linkCount: total };

    const better = sharers.filter((s) => dominates(s, self));
    if (better.length > 0) {
      toSoftDelete.push(artistId);
      const describe = (s) => `${s.name} (${s.directory_status}, ${s.linkCount} links)`;
      record(
        "to-soft-delete",
        `this row holds only the one link; kept instead: ${better.map(describe).join("; ")}`,
        better
      );
      continue;
    }

    // Nothing beats it. Two shapes of stalemate are worth a human's time.
    const incomparable = sharers.filter(
      (s) => rank(self).approved > rank(s).approved && s.linkCount > total
    );
    if (incomparable.length > 0) {
      record(
        "skipped",
        "approved with one link, but a row that is NOT in the directory holds " +
          "more — deleting this would drop the artist from the site; merge by hand",
        incomparable
      );
      continue;
    }

    const tied = sharers.filter(
      (s) => rank(s).approved === rank(self).approved && s.linkCount === total
    );
    if (tied.length > 0) {
      record(
        "skipped",
        "same status and one link each — nothing to choose between them; " +
          "pick a survivor by hand",
        tied
      );
      continue;
    }

    // This row beats every sharer outright: it is the survivor, not a problem.
  }

  return { toSoftDelete, audit };
}
