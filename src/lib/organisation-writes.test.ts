import { describe, it, expect, vi } from "vitest";
import {
  resolveOrganisationInputs,
  promoteArtistLabelsToOrganisations,
  DEFAULT_ROLE,
} from "./organisation-writes";

/**
 * A tiny stand-in for the Supabase client: `tables` maps a table name to
 * the rows it holds, and inserts are recorded so the tests can assert on
 * what was written.
 */
function fakeAdmin(tables: Record<string, Record<string, unknown>[]>) {
  const inserted: Record<string, Record<string, unknown>[]> = {};
  const upserted: Record<string, Record<string, unknown>[]> = {};

  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])];
    const builder: Record<string, unknown> = {};
    const filter = (column: string, value: unknown) => {
      rows = rows.filter((r) => r[column] === value);
      return builder;
    };
    Object.assign(builder, {
      select: () => builder,
      eq: filter,
      is: filter,
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((r) => values.includes(r[column]));
        return builder;
      },
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        const list = Array.isArray(payload) ? payload : [payload];
        inserted[table] = [...(inserted[table] ?? []), ...list];
        // Mimic .insert().select().single() returning the new row.
        const created = { id: `new-${(inserted[table] ?? []).length}`, ...list[0] };
        tables[table] = [...(tables[table] ?? []), created];
        return {
          select: () => ({ single: () => Promise.resolve({ data: created, error: null }) }),
          then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
        };
      },
      upsert: (payload: Record<string, unknown>[]) => {
        upserted[table] = [...(upserted[table] ?? []), ...payload];
        return Promise.resolve({ error: null });
      },
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(res),
    });
    return builder;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: { from } as any, inserted, upserted };
}

const APPROVED = { id: "org-1", name: "Ostgut Ton", status: "approved", duplicate_of: null };
const PENDING = { id: "org-2", name: "Trip Records", status: "pending", duplicate_of: null };

describe("resolveOrganisationInputs", () => {
  it("accepts an id that really is an approved organisation", async () => {
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(admin, [
      { id: "org-1", name: "Ostgut Ton" },
    ]);
    expect(result).toEqual({
      resolved: [{ organisationId: "org-1", roleKey: DEFAULT_ROLE }],
      names: [],
    });
  });

  it("demotes an id that is not approved to a plain name", async () => {
    // The browser sent an id for a PENDING organisation — either a stale
    // page or a hand-edited request. It must not become an association.
    const { admin } = fakeAdmin({ organisations: [APPROVED, PENDING] });
    const result = await resolveOrganisationInputs(admin, [
      { id: "org-2", name: "Trip Records" },
    ]);
    expect(result).toEqual({ resolved: [], names: ["Trip Records"] });
  });

  it("demotes an id that no longer exists rather than dropping the row", async () => {
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(admin, [
      { id: "deleted-since-page-load", name: "Some Label" },
    ]);
    expect(result).toEqual({ resolved: [], names: ["Some Label"] });
  });

  it("treats a typed name with no id as a name", async () => {
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(admin, [{ name: "Brand New Label" }]);
    expect(result).toEqual({ resolved: [], names: ["Brand New Label"] });
  });

  it("drops blank rows and de-duplicates (organisation, role) pairs", async () => {
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(admin, [
      { id: "org-1", name: "Ostgut Ton" },
      { id: "org-1", name: "Ostgut Ton" },
      { name: "   " },
    ]);
    expect(result.resolved).toHaveLength(1);
    expect(result.names).toEqual([]);
  });

  // ── role handling ────────────────────────────────────────────────

  it("IGNORES a posted role unless the caller allows roles", async () => {
    // The public submit and revise paths call without allowRoles. A
    // hand-edited request claiming 'head' must still land as 'associated'
    // — a stranger cannot assert that somebody runs a label.
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(admin, [
      { id: "org-1", name: "Ostgut Ton", role_key: "head" },
    ]);
    expect(result.resolved).toEqual([
      { organisationId: "org-1", roleKey: DEFAULT_ROLE },
    ]);
  });

  it("honours a posted role when the caller allows roles", async () => {
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(
      admin,
      [{ id: "org-1", name: "Ostgut Ton", role_key: "head" }],
      { allowRoles: true },
    );
    expect(result.resolved).toEqual([{ organisationId: "org-1", roleKey: "head" }]);
  });

  it("keeps the same organisation under two different roles", async () => {
    // owner AND resident at one place is two rows — what the composite
    // primary key exists to allow.
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(
      admin,
      [
        { id: "org-1", name: "Ostgut Ton", role_key: "owner" },
        { id: "org-1", name: "Ostgut Ton", role_key: "resident" },
      ],
      { allowRoles: true },
    );
    expect(result.resolved).toEqual([
      { organisationId: "org-1", roleKey: "owner" },
      { organisationId: "org-1", roleKey: "resident" },
    ]);
  });

  it("falls back to the default role when allowRoles is on but none is given", async () => {
    const { admin } = fakeAdmin({ organisations: [APPROVED] });
    const result = await resolveOrganisationInputs(
      admin,
      [{ id: "org-1", name: "Ostgut Ton" }],
      { allowRoles: true },
    );
    expect(result.resolved).toEqual([
      { organisationId: "org-1", roleKey: DEFAULT_ROLE },
    ]);
  });
});

describe("promoteArtistLabelsToOrganisations", () => {
  it("creates a PENDING organisation for a name that has none", async () => {
    const { admin, inserted, upserted } = fakeAdmin({
      artist_labels: [{ artist_id: "a1", name: "Brand New Label" }],
      organisations: [],
    });

    const result = await promoteArtistLabelsToOrganisations(admin, "a1");

    expect(result.created).toBe(1);
    // Pending, not approved: approving an ARTIST is not the same
    // judgement as deciding a label is correctly named and located.
    expect(inserted.organisations).toEqual([
      { name: "Brand New Label", status: "pending" },
    ]);
    expect(upserted.artist_organisations?.[0]).toMatchObject({
      artist_id: "a1",
      role_key: DEFAULT_ROLE,
    });
  });

  it("reuses an organisation matching on the normalised name", async () => {
    const { admin, inserted, upserted } = fakeAdmin({
      artist_labels: [{ artist_id: "a1", name: "ostgut-ton" }],
      organisations: [{ ...APPROVED, name_search: "ostgutton" }],
    });

    const result = await promoteArtistLabelsToOrganisations(admin, "a1");

    expect(result).toEqual({ created: 0, attached: 1 });
    expect(inserted.organisations).toBeUndefined();
    expect(upserted.artist_organisations).toEqual([
      { artist_id: "a1", organisation_id: "org-1", role_key: DEFAULT_ROLE },
    ]);
  });

  it("does not resurrect a rejected organisation as a new row", async () => {
    // Reuse is status-blind on purpose: creating a second row with the
    // same name is how duplicate pairs get made.
    const { admin, inserted } = fakeAdmin({
      artist_labels: [{ artist_id: "a1", name: "Trip Records" }],
      organisations: [
        { id: "org-9", name: "Trip Records", name_search: "triprecords", status: "rejected" },
      ],
    });

    const result = await promoteArtistLabelsToOrganisations(admin, "a1");

    expect(result.created).toBe(0);
    expect(inserted.organisations).toBeUndefined();
  });

  it("is a no-op for an artist with no labels", async () => {
    const { admin, inserted, upserted } = fakeAdmin({ artist_labels: [], organisations: [] });
    const result = await promoteArtistLabelsToOrganisations(admin, "a1");
    expect(result).toEqual({ created: 0, attached: 0 });
    expect(inserted.organisations).toBeUndefined();
    expect(upserted.artist_organisations).toBeUndefined();
  });

  it("de-duplicates repeated label spellings into one organisation", async () => {
    const { admin, inserted } = fakeAdmin({
      artist_labels: [
        { artist_id: "a1", name: "Ostgut Ton" },
        { artist_id: "a1", name: "Ostgut Ton" },
      ],
      organisations: [],
    });
    const result = await promoteArtistLabelsToOrganisations(admin, "a1");
    expect(result.created).toBe(1);
    expect(inserted.organisations).toHaveLength(1);
  });
});
