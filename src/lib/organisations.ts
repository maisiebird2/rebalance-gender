// Shared shaping for the organisation read path (phase 4 of
// documentation/PROPOSAL-organisations.md).
//
// One artist_organisations row is a fact about an artist AND about an
// organisation, so both pages render the same data inverted: the artist
// page groups an artist's organisations by role ("Resident: Tresor"),
// the organisation page groups an organisation's artists by the same
// role ("Resident: Ada, Bea"). The grouping is therefore written once
// here rather than twice in the two pages.

import type { OrganisationRole } from "./types";

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
