// ============================================================
// The link editor's form state: an ordered list of pasted URLs, plus the two
// things that are stated about a platform rather than typed as a URL.
//
// Pure, so it can be tested without rendering anything — the component in
// components/form/ProfileLinksList.tsx is the view over this.
// ============================================================

import {
  assignPlatforms,
  isLinkError,
  OVERFLOW_PLATFORM,
  type LinkAssignment,
} from "./assign-platforms";
import type { LinkPayloadRow } from "./link-payload";

/** The platform whose link nobody can detect from a host: someone's own site. */
export const HOMEPAGE_PLATFORM = "homepage";

export interface LinkRow {
  /** Stable React key. Client-generated; never sent anywhere. */
  id: string;
  /** The URL as typed. The only authoritative field — the platform is derived. */
  text: string;
  /**
   * The platform this row was loaded with, or null once its text is edited.
   *
   * A loaded row must keep its stored platform until someone changes it: the
   * server rewrites URLs and platforms a beat after every save
   * (schedule-link-resolution.ts), so a freshly loaded form routinely holds
   * rows the client detector cannot reproduce. Editing the text is the signal
   * that the stored answer is no longer about this URL.
   */
  storedPlatform: string | null;
}

let rowCounter = 0;

/** A new row. Ids are sequential rather than random so that a server render
 *  and its hydration produce the same keys. */
export function newLinkRow(text = "", storedPlatform: string | null = null): LinkRow {
  return { id: `link-row-${rowCounter++}`, text, storedPlatform };
}

/** A row whose text has been edited, and so must re-derive its platform. */
export function editLinkRow(row: LinkRow, text: string): LinkRow {
  return { ...row, text, storedPlatform: null };
}

/** The stored link shape both artist and organisation pages load. */
interface StoredLink {
  platform: string;
  url: string | null;
  original_url?: string | null;
  not_found?: boolean | null;
}

export interface LinkEditorState {
  rows: LinkRow[];
  /** The homepage field, kept beside the list — see HOMEPAGE_PLATFORM. */
  homepage: string;
  /** Platform keys someone has recorded the artist as not being on. */
  notFound: string[];
}

/**
 * Builds the editor's initial state from an artist's stored links.
 *
 * `prefer` decides which stored URL a row shows. The edit form shows the
 * canonical `url` (the truer current state of the record); the public revision
 * form shows `original_url` where there is one, so a visitor is looking at the
 * link as it was given rather than at a rewritten form of it. Both were already
 * true before this list existed, and neither is this change's call to settle.
 */
export function linkEditorStateFromLinks(
  links: readonly StoredLink[] | null | undefined,
  prefer: "url" | "original" = "url"
): LinkEditorState {
  const all = links ?? [];
  const textOf = (l: StoredLink) =>
    (prefer === "original" ? l.original_url ?? l.url : l.url) ?? "";

  const homepageLink = all.find((l) => l.platform === HOMEPAGE_PLATFORM && !l.not_found && l.url);

  return {
    rows: all
      .filter((l) => !l.not_found && l.url && l.platform !== HOMEPAGE_PLATFORM)
      .map((l) => newLinkRow(textOf(l), l.platform)),
    homepage: homepageLink ? textOf(homepageLink) : "",
    notFound: all.filter((l) => l.not_found).map((l) => l.platform),
  };
}

/** A row with its derived platform, ready to render. */
export type DerivedLinkRow = LinkRow & LinkAssignment;

export interface DerivedLinkEditorState {
  /** The homepage field's assignment, so the form can warn when what was typed
   *  there is plainly a platform link rather than someone's own site. */
  homepage: LinkAssignment;
  rows: DerivedLinkRow[];
  /** Platforms currently held by a primary link, homepage included. */
  primaryPlatforms: Set<string>;
}

/**
 * Runs the derivation over the editor's state, in the same order
 * serializeLinkRows posts it, so what someone sees while typing is exactly
 * what the server will decide.
 */
export function deriveLinkEditorState(state: LinkEditorState): DerivedLinkEditorState {
  const homepage = state.homepage.trim();
  const assigned = assignPlatforms([
    { id: "homepage", text: homepage, url: homepage, storedPlatform: homepage ? HOMEPAGE_PLATFORM : null },
    ...state.rows.map((row) => ({ ...row, url: row.text })),
  ]);

  const [homepageAssignment, ...rowAssignments] = assigned;
  const primaryPlatforms = new Set(
    assigned
      .filter((a) => a.kind === "primary" && a.platform && a.platform !== OVERFLOW_PLATFORM)
      .map((a) => a.platform as string)
  );

  return {
    homepage: homepageAssignment,
    rows: rowAssignments.map(({ id, text, storedPlatform, platform, kind, occupiedPlatform }) => ({
      id,
      text,
      storedPlatform,
      platform,
      kind,
      occupiedPlatform,
    })),
    primaryPlatforms,
  };
}

/** True when something typed cannot be stored and has to be fixed first. */
export function hasLinkErrors(state: LinkEditorState): boolean {
  const derived = deriveLinkEditorState(state);
  return isLinkError(derived.homepage.kind) || derived.rows.some((r) => isLinkError(r.kind));
}

/**
 * The platforms it still makes sense to mark "not found": everything with no
 * primary link and no marker already. An overflow row on a host does NOT block
 * marking it — an "other" row means the platform's own slot is still empty.
 */
export function markableNotFoundPlatforms(
  state: LinkEditorState,
  platformKeys: readonly string[]
): string[] {
  const { primaryPlatforms } = deriveLinkEditorState(state);
  const marked = new Set(state.notFound);
  return platformKeys.filter(
    (key) => key !== OVERFLOW_PLATFORM && !primaryPlatforms.has(key) && !marked.has(key)
  );
}

/**
 * The payload the forms post, in the order the derivation depends on.
 *
 * Homepage goes first — it is the first thing shown on an artist page, and a
 * pasted list is read top to bottom, so it should not be the one row whose
 * position is arbitrary. Not-found markers go last: they are statements about
 * platforms with no link, so they cannot compete for a slot with anything
 * ahead of them.
 */
export function serializeLinkRows(state: LinkEditorState): LinkPayloadRow[] {
  const payload: LinkPayloadRow[] = [];
  let position = 0;

  const homepage = state.homepage.trim();
  if (homepage) {
    payload.push({
      platform: HOMEPAGE_PLATFORM,
      url: homepage,
      not_found: false,
      position: position++,
    });
  }

  for (const row of state.rows) {
    const text = row.text.trim();
    if (!text) continue;
    payload.push({
      platform: row.storedPlatform ?? "",
      url: text,
      not_found: false,
      position: position++,
    });
  }

  // A marker for a platform that now has a link is dropped, so the form agrees
  // with what resolveLinkPayload would do with it anyway. Someone pasting a
  // SoundCloud link should not have to also remember to clear the "not on
  // SoundCloud" chip they set earlier.
  const { primaryPlatforms } = deriveLinkEditorState(state);
  for (const platform of state.notFound) {
    if (primaryPlatforms.has(platform)) continue;
    payload.push({ platform, url: null, not_found: true, position: position++ });
  }

  return payload;
}
