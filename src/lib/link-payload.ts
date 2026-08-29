// ============================================================
// The wire format for profile links, and the server-side fold that turns a
// submitted list into rows for artist_links.
//
// One array, sent by every artist form (submit, revise, edit) — replacing the
// per-platform `Partial<Record<platform, url>>` map that submit and revise
// used to post. See documentation/PROPOSAL-platform-links-v2.md §4.
//
// The array's ORDER is authoritative: it is what assignPlatforms() folds over
// to decide which link is a platform's primary. `position` is carried
// alongside so a payload sitting in the revision queue still records its own
// order, and so the optional artist_links.position column can be added later
// without a format change. Nothing here re-sorts by it.
// ============================================================

import {
  assignPlatforms,
  isUnstorable,
  OVERFLOW_PLATFORM,
  type LinkAssignmentKind,
} from "./assign-platforms";
import { classifyPlatformUrl } from "./classify-platform-url";
import { resolveProfileLinkUrl } from "./profile-links";

export interface LinkPayloadRow {
  /**
   * The platform the CLIENT believes this row has. Advisory for URL rows: the
   * server re-derives, and only honours this where detection cannot have an
   * answer of its own (see trustedClientPlatform). Authoritative for not-found
   * markers, which have no URL to detect from.
   */
  platform: string;
  /** null on a not-found marker; the URL as typed otherwise. */
  url: string | null;
  not_found: boolean;
  /** The row's index in the list. Informational — array order is authoritative. */
  position: number;
}

/** A row that is ready to be written, with its platform settled. */
export interface ResolvedLinkRow {
  platform: string;
  /** The URL as submitted. Callers still canonicalise it (resolveProfileLinkUrl). */
  url: string | null;
  not_found: boolean;
  position: number;
  /** Why this row got the platform it did — "marker" for a not-found row. */
  kind: LinkAssignmentKind | "marker";
}

/** A submitted row that cannot be stored at all, and why. */
export interface RejectedLinkRow {
  url: string;
  position: number;
  kind: Extract<LinkAssignmentKind, "not-a-url" | "refused">;
}

/**
 * Reads a links payload in EITHER shape.
 *
 * The old shape is a platform-keyed map (`{soundcloud: "https://…"}`), which
 * the submit and revise forms posted before this format existed. It has to
 * keep working for one reason that is not backwards compatibility for its own
 * sake: `api/revise` stores its payload in `revision_data` and the links only
 * become rows when an admin approves, possibly days later. At deploy time the
 * queue holds old-shape payloads written by a form that no longer exists, and
 * nobody is going to rewrite them — the same reasoning that keeps the `labels`
 * back-compat in admin/actions.ts.
 *
 * Returns [] for anything unrecognisable rather than throwing: a malformed
 * links field should not cost a revision the rest of its content.
 */
export function parseLinkPayload(raw: unknown): LinkPayloadRow[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r, i) => ({
        platform: typeof r.platform === "string" ? r.platform : "",
        url: typeof r.url === "string" ? r.url : null,
        not_found: r.not_found === true,
        position: typeof r.position === "number" ? r.position : i,
      }))
      .filter((r) => r.not_found || (r.url ?? "").trim() !== "");
  }

  if (raw && typeof raw === "object") {
    // Legacy map shape. It could only ever express one link per platform and
    // carried no order, so the map's own key order becomes the list order.
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, url]) => typeof url === "string" && url.trim() !== "")
      .map(([platform, url], i) => ({
        platform,
        url: (url as string).trim(),
        not_found: false,
        position: i,
      }));
  }

  return [];
}

/**
 * Settles the platform for every row in a submitted payload.
 *
 * URL rows go through assignPlatforms — first link on a known host wins,
 * everything after it overflows to "other". Not-found markers carry no URL to
 * detect from, so they are handled here rather than inside that fold: each
 * holds its platform's one slot, and a marker for a platform that a real link
 * also claims is DROPPED. That last rule is the server's backstop, not the
 * product behaviour — the editor's own guard is "you can't mark a platform
 * not-found while a primary link for it exists" — but without it a payload
 * carrying both would be rejected wholesale by the partial unique index.
 *
 * Rejected rows are returned separately rather than silently dropped, so a
 * caller can surface them. Nothing that cannot be stored is ever quietly
 * refiled under "other": a policy-refused host stays refused.
 */
export function resolveLinkPayload(rows: readonly LinkPayloadRow[]): {
  rows: ResolvedLinkRow[];
  rejected: RejectedLinkRow[];
} {
  const urlRows = rows.filter((r) => !r.not_found);
  const markers = rows.filter((r) => r.not_found && r.platform.trim());

  const assigned = assignPlatforms(
    urlRows.map((row) => ({
      ...row,
      url: row.url ?? "",
      storedPlatform: trustedClientPlatform(row),
    }))
  );

  const resolved: ResolvedLinkRow[] = [];
  const rejected: RejectedLinkRow[] = [];
  const claimedByLinks = new Set<string>();

  for (const row of assigned) {
    if (row.kind === "not-a-url" || row.kind === "refused") {
      rejected.push({ url: row.url, position: row.position, kind: row.kind });
      continue;
    }
    if (isUnstorable(row.kind) || !row.platform) continue;
    if (row.platform !== OVERFLOW_PLATFORM) claimedByLinks.add(row.platform);
    resolved.push({
      platform: row.platform,
      url: row.url,
      not_found: false,
      position: row.position,
      kind: row.kind,
    });
  }

  const seenMarkers = new Set<string>();
  for (const marker of markers) {
    const platform = marker.platform.trim();
    if (claimedByLinks.has(platform) || seenMarkers.has(platform)) continue;
    seenMarkers.add(platform);
    resolved.push({
      platform,
      url: null,
      not_found: true,
      position: marker.position,
      kind: "marker",
    });
  }

  return { rows: resolved, rejected };
}

/**
 * The platform claim to trust from a client, or null to re-derive.
 *
 * Honoured ONLY where host detection has no answer of its own — where
 * `classifyPlatformUrl` falls back to "other". This is the same policy
 * `reclassifyResolvedUrl` applies when a shortener resolves, for the same
 * reason: "other" is the classifier's fallback, not a finding, so letting it
 * override a more specific key would throw information away. It is what lets
 * `homepage` survive a round trip — a first-class platform no host lookup can
 * ever assign — without letting a client relabel an obvious SoundCloud URL as
 * something else.
 */
function trustedClientPlatform(row: LinkPayloadRow): string | null {
  const claimed = row.platform?.trim();
  if (!claimed) return null;
  const url = (row.url ?? "").trim();
  if (!url) return null;
  return classifyPlatformUrl(url) === OVERFLOW_PLATFORM ? claimed : null;
}

/**
 * Canonicalises a pasted URL for storage, by what the URL IS rather than by
 * the slot it lands in.
 *
 * The distinction only shows up for overflow rows. A label's SoundCloud page
 * is stored under "other" because the artist's own SoundCloud already holds
 * that slot — but it is still a SoundCloud URL, and canonicalising it as one
 * (stripping the tracking query, rebuilding it from the handle) is right,
 * where cleanGenericUrl("other", …) would leave it as pasted. This is also
 * how resolve-artist-links.ts canonicalises a link it has just resolved: by
 * the platform the URL turned out to be.
 *
 * The stored `handle`, by contrast, is derived from the row's STORED platform,
 * so that a row's handle and platform never disagree.
 */
export function canonicalLinkUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;
  const detected = classifyPlatformUrl(trimmed);
  // A refused or unparseable URL is never stored, so its canonical form is
  // academic — return it untouched rather than inventing one.
  if (detected === null) return trimmed;
  return resolveProfileLinkUrl(detected, trimmed);
}
