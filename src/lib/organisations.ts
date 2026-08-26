// Shared shaping for the organisation read path (phase 4 of
// documentation/ORGANISATIONS.md).
//
// One artist_organisations row is a fact about an artist AND about an
// organisation, so both pages render the same data inverted: the artist
// page groups an artist's organisations by role ("Resident: Tresor"),
// the organisation page groups an organisation's artists by the same
// role ("Resident: Ada, Bea"). The grouping is therefore written once
// here rather than twice in the two pages.

import { normalisedNameKey } from "./name-key.mjs";
import type {
  ArtistOrganisationEntry,
  OrganisationFormRow,
  OrganisationRole,
} from "./types";

/** Mirrors DEFAULT_ROLE in organisation-writes.ts, which is server-only. */
export const DEFAULT_ROLE_KEY = "associated";

export interface RoleGroup<T> {
  role: OrganisationRole;
  items: T[];
}

/**
 * Group rows by the role they carry, ordered by the vocabulary's own
 * `sort_order` so 'associated' leads and the specific roles follow in
 * the order an admin arranged them.
 *
 * Items keep the order they arrive in — callers sort by whatever reads
 * best for their direction (organisation name on the artist page, artist
 * name on the organisation page).
 */
export function groupByRole<T>(
  entries: readonly T[],
  getRole: (entry: T) => OrganisationRole,
): RoleGroup<T>[] {
  const groups = new Map<string, RoleGroup<T>>();

  for (const entry of entries) {
    const role = getRole(entry);
    let group = groups.get(role.key);
    if (!group) {
      group = { role, items: [] };
      groups.set(role.key, group);
    }
    group.items.push(entry);
  }

  // sort_order first, key second — two roles sharing a sort_order (easy
  // to do by hand in the admin panel) must still render in a stable
  // order rather than one that depends on which artist loaded first.
  return [...groups.values()].sort(
    (a, b) => a.role.sort_order - b.role.sort_order || a.role.key.localeCompare(b.role.key),
  );
}

/** What the line is listing — the two directions the same row is read in. */
export type RoleDirection = "organisations" | "artists";

/**
 * The heading for one role's line.
 *
 * 'associated' is the only role whose wording depends on direction.
 * Listing an artist's organisations it keeps the exact phrasing the flat
 * label text has always used ("Associated with: BPitch Control"), so the
 * migration is invisible where nothing more specific is known — which is
 * every backfilled row. Listing an organisation's artists, that same
 * phrasing reads backwards ("Associated with: Ellen Allien, ..." on
 * BPitch Control's own page), so the preposition is dropped.
 *
 * Everything else is just the label with a capital, in both directions.
 * It is tempting to write per-role prepositions ("Head of:", "Resident
 * at:"), but the vocabulary is editable from /admin/settings: the first
 * role somebody adds would have no preposition and fall back to
 * something worse than this. A plain label reads fine for every role in
 * the seeded set and for any role added later.
 */
export function roleHeading(role: OrganisationRole, direction: RoleDirection): string {
  if (role.key === "associated") {
    return direction === "organisations" ? "Associated with" : "Associated";
  }
  return role.label.charAt(0).toUpperCase() + role.label.slice(1);
}

/**
 * Seed the forms' Organisations field from an artist's current data.
 *
 * Two sources, because the migration is mid-flight: organisations already
 * attached (which carry an id) and `artist_labels` names that haven't
 * become organisations yet (which don't). A name present in both — the
 * normal state once an organisation has been created but the flat row is
 * still there for the dual-read — appears ONCE, with its id, so editing
 * the field doesn't silently split one organisation into two rows.
 *
 * Only the `associated` role is included. That role is what the flat label
 * text has always meant and is the only one this field manages; head,
 * resident and the rest are set on /admin/organisations, and the
 * revision-apply path deletes only `associated` rows so they survive an
 * edit here untouched.
 */
export function initialOrganisationRows(
  organisations: ArtistOrganisationEntry[] | undefined,
  labels: { name: string }[] | undefined,
): OrganisationFormRow[] {
  const rows: OrganisationFormRow[] = [];
  const seen = new Set<string>();

  for (const entry of organisations ?? []) {
    if (entry.role.key !== "associated") continue;
    const key = normalisedNameKey(entry.organisation.name);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: entry.organisation.id, name: entry.organisation.name });
  }

  for (const label of labels ?? []) {
    const key = normalisedNameKey(label.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: null, name: label.name });
  }

  return rows.length > 0 ? rows : [{ id: null, name: "" }];
}

/**
 * The admin edit form's seeding: EVERY organisation the artist is attached
 * to, one row per (organisation, role), plus the unresolved names.
 *
 * The associated-only variant above deliberately hides other roles, because
 * the public forms can't edit them and mustn't silently drop them on save.
 * On the admin form that same filter was a defect: an artist who is `head`
 * of an organisation showed NOTHING for it, while their public page rendered
 * "Head: …". The form concealed data the page displayed.
 *
 * The same organisation under two roles is two rows, which is the point —
 * owner AND resident is what the composite primary key exists to allow.
 */
export function initialOrganisationRowsWithRoles(
  organisations: ArtistOrganisationEntry[] | undefined,
  labels: { name: string }[] | undefined,
): OrganisationFormRow[] {
  const rows: OrganisationFormRow[] = [];
  const seenPairs = new Set<string>();
  const seenNames = new Set<string>();

  for (const entry of organisations ?? []) {
    const nameKey = normalisedNameKey(entry.organisation.name);
    const pair = `${nameKey}|${entry.role.key}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    seenNames.add(nameKey);
    rows.push({
      id: entry.organisation.id,
      name: entry.organisation.name,
      role_key: entry.role.key,
    });
  }

  // A flat label whose organisation is already attached in ANY role is
  // the dual-read's redundant copy, not a second thing to edit.
  for (const label of labels ?? []) {
    const key = normalisedNameKey(label.name);
    if (!key || seenNames.has(key)) continue;
    seenNames.add(key);
    rows.push({ id: null, name: label.name, role_key: DEFAULT_ROLE_KEY });
  }

  return rows.length > 0 ? rows : [{ id: null, name: "", role_key: DEFAULT_ROLE_KEY }];
}
