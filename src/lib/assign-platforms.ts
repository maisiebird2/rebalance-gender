// ============================================================
// assignPlatforms: an ordered list of pasted URLs -> a platform per row.
//
// The single rule behind the paste-to-detect link editor
// (documentation/PROPOSAL-platform-links-v2.md §1):
//
//   Walk links in order. Detect each URL's host-platform. The FIRST link
//   on a given known host takes that platform; every later link on the
//   same host — and anything on an unrecognised host — becomes "other".
//
// Two properties fall out of deriving rather than storing the platform:
// deleting a primary auto-promotes the next same-host link (the fold just
// re-runs), and "at most one primary per known platform, unlimited other"
// holds by construction — the same invariant the partial unique index
// added by supabase_migration_artist_links_overflow.sql enforces.
//
// Called from three places, which is the whole point of it being one
// function: the link editor on every change, the server save paths before
// insert, and the post-save resolution pass when a resolved URL wants to
// move onto a slot that is already taken.
//
// Detection itself is NOT implemented here — it is classifyPlatformUrl(),
// shared with every harvester. This module only folds it over an ordered
// list and decides who wins a contested slot.
// ============================================================

import { classifyPlatformUrl } from "./classify-platform-url";
import { unwrapRedirectUrl } from "./profile-links";

/** The bucket every non-primary link lands in. Unlimited per artist. */
export const OVERFLOW_PLATFORM = "other";

/**
 * What happened to one row. The kinds that are not simply "primary" all need
 * the UI to say something, because each is a case where what someone typed is
 * not what gets stored:
 *
 *   - `overflow`     a known host whose primary slot was already claimed by an
 *                    earlier row, so this one is filed under "other".
 *   - `unrecognised` no rule matched the host; filed under "other" as well,
 *                    but for a different reason and needing a different note.
 *   - `not-a-url`    not an http(s) URL at all — a bare handle, a typo, a
 *                    mailto:. Unlike the per-platform fields this replaces, a
 *                    bare handle cannot be accepted: there is no platform to
 *                    build a URL for until the host says what it is.
 *   - `refused`      a real http(s) URL on a host the project excludes
 *                    (twitter/x/t.co). NOT filed under "other" — doing so
 *                    would smuggle an excluded link in through the front door.
 *   - `blank`        empty row; dropped on serialise.
 */
export type LinkAssignmentKind =
  | "blank"
  | "primary"
  | "overflow"
  | "unrecognised"
  | "not-a-url"
  | "refused";

export interface AssignPlatformsInput {
  /** The URL as typed or as stored. The only authoritative field. */
  url: string;
  /**
   * The platform already recorded for this row, when the caller knows it to be
   * authoritative — a stored row that has not been edited since it loaded.
   *
   * Trusting it is not an optimisation, it is required. Post-save resolution
   * rewrites both URLs and platforms a beat after every save
   * (schedule-link-resolution.ts), so a freshly loaded edit form routinely
   * holds rows this module's detector cannot reproduce. `homepage` is the
   * permanent case: a first-class platform no host lookup can ever assign.
   *
   * Clear it the moment the row's text is edited, and the row re-derives.
   */
  storedPlatform?: string | null;
}

export interface LinkAssignment {
  /** The platform key to store, or null when the row must not be stored. */
  platform: string | null;
  kind: LinkAssignmentKind;
  /** On `overflow`: the known platform whose primary is already taken. */
  occupiedPlatform?: string;
}

/** True when `text` parses as an http(s) URL — the shape classification needs. */
function isHttpUrl(text: string): boolean {
  try {
    return /^https?:$/.test(new URL(text).protocol);
  } catch {
    return false;
  }
}

/**
 * Derives the platform for every row in an ordered list. Pure: same list in,
 * same list out, so the client and the server always agree.
 *
 * Returns each input row with the assignment merged in, preserving order and
 * any extra fields the caller carries (React keys, ids, not_found flags).
 */
export function assignPlatforms<T extends AssignPlatformsInput>(
  rows: readonly T[]
): Array<T & LinkAssignment> {
  // Known platforms already claimed by an earlier row. "other" is never in
  // here — that is the point of the overflow bucket.
  const claimed = new Set<string>();

  return rows.map((row) => {
    const assignment = assignOne(row, claimed);
    return { ...row, ...assignment };
  });
}

function assignOne(row: AssignPlatformsInput, claimed: Set<string>): LinkAssignment {
  const text = (row.url ?? "").trim();
  if (!text) return { platform: null, kind: "blank" };

  // Expand Instagram/Facebook link shims (l.instagram.com/?u=…) before looking
  // at the host, so a wrapped SoundCloud link detects as SoundCloud. The row's
  // own text is left alone — rewriting it is normalisation's job, on blur.
  const unwrapped = unwrapRedirectUrl(text);

  if (!isHttpUrl(unwrapped)) return { platform: null, kind: "not-a-url" };

  const detected = classifyPlatformUrl(unwrapped);
  // null is the policy refusal (twitter/x/t.co), which the shape check above
  // has already separated from "not a URL at all".
  if (detected === null) return { platform: null, kind: "refused" };

  // A stored row keeps its platform whatever detection now says — but it still
  // occupies its slot, so a later row on the same host correctly overflows.
  const stored = row.storedPlatform?.trim();
  if (stored) {
    if (stored === OVERFLOW_PLATFORM) {
      // Already in the bucket. Say WHY, so the note matches the reason: a
      // stored "other" row on a taken known host is overflow; anything else
      // is simply an unrecognised host.
      return detected !== OVERFLOW_PLATFORM && claimed.has(detected)
        ? { platform: OVERFLOW_PLATFORM, kind: "overflow", occupiedPlatform: detected }
        : { platform: OVERFLOW_PLATFORM, kind: "unrecognised" };
    }
    // Two stored rows claiming one known platform cannot happen through the
    // partial unique index, but the fold must still be total.
    if (claimed.has(stored)) {
      return { platform: OVERFLOW_PLATFORM, kind: "overflow", occupiedPlatform: stored };
    }
    claimed.add(stored);
    return { platform: stored, kind: "primary" };
  }

  if (detected === OVERFLOW_PLATFORM) {
    return { platform: OVERFLOW_PLATFORM, kind: "unrecognised" };
  }

  if (claimed.has(detected)) {
    return { platform: OVERFLOW_PLATFORM, kind: "overflow", occupiedPlatform: detected };
  }

  claimed.add(detected);
  return { platform: detected, kind: "primary" };
}

/** True when the row must not be written to the database. */
export function isUnstorable(kind: LinkAssignmentKind): boolean {
  return kind === "blank" || kind === "not-a-url" || kind === "refused";
}

/**
 * True when the row is a problem the person has to fix before saving —
 * something they typed that this design cannot store. A blank row is not a
 * problem; it is just dropped.
 */
export function isLinkError(kind: LinkAssignmentKind): boolean {
  return kind === "not-a-url" || kind === "refused";
}
