import { describe, it, expect } from "vitest";
import {
  groupByRole,
  roleHeading,
  normalisedNameKey,
  initialOrganisationRows,
  initialOrganisationRowsWithRoles,
} from "./organisations";
import type { OrganisationRole } from "./types";

const role = (key: string, sort_order: number, label = key): OrganisationRole => ({
  key,
  label,
  sort_order,
});

const ASSOCIATED = role("associated", 10, "associated");
const HEAD = role("head", 20, "head");
const RESIDENT = role("resident", 70, "resident");

describe("groupByRole", () => {
  it("groups by role and orders by sort_order", () => {
    const entries = [
      { name: "Tresor", role: RESIDENT },
      { name: "Ostgut Ton", role: ASSOCIATED },
      { name: "PAN", role: HEAD },
    ];
    const groups = groupByRole(entries, (e) => e.role);
    expect(groups.map((g) => g.role.key)).toEqual(["associated", "head", "resident"]);
  });

  it("collects several items under one role, keeping input order", () => {
    const entries = [
      { name: "Tresor", role: ASSOCIATED },
      { name: "PAN", role: ASSOCIATED },
    ];
    const groups = groupByRole(entries, (e) => e.role);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.name)).toEqual(["Tresor", "PAN"]);
  });

  it("orders two roles sharing a sort_order deterministically", () => {
    const a = role("aaa", 10);
    const b = role("bbb", 10);
    const forwards = groupByRole([{ role: a }, { role: b }], (e) => e.role);
    const backwards = groupByRole([{ role: b }, { role: a }], (e) => e.role);
    expect(forwards.map((g) => g.role.key)).toEqual(backwards.map((g) => g.role.key));
  });

  it("is empty for no entries", () => {
    expect(groupByRole([], (e: { role: OrganisationRole }) => e.role)).toEqual([]);
  });
});

describe("roleHeading", () => {
  it("keeps the wording the flat label text always used, listing organisations", () => {
    expect(roleHeading(ASSOCIATED, "organisations")).toBe("Associated with");
  });
  it("drops the preposition listing artists, where it would read backwards", () => {
    // On BPitch Control's own page, "Associated with: Ellen Allien" is
    // the wrong way round.
    expect(roleHeading(ASSOCIATED, "artists")).toBe("Associated");
  });
  it("capitalises any other role, including one added later, in both directions", () => {
    for (const direction of ["organisations", "artists"] as const) {
      expect(roleHeading(HEAD, direction)).toBe("Head");
      expect(roleHeading(role("a_r", 90, "A&R"), direction)).toBe("A&R");
      expect(roleHeading(role("tour_manager", 130, "tour manager"), direction)).toBe("Tour manager");
    }
  });
});

describe("normalisedNameKey", () => {
  it("collapses case, spaces and punctuation", () => {
    for (const name of ["Ostgut Ton", "ostgut ton", "Ostgut-Ton", "OSTGUT  TON!"]) {
      expect(normalisedNameKey(name)).toBe("ostgutton");
    }
  });
  it("strips diacritics the way Postgres unaccent does", () => {
    expect(normalisedNameKey("Öştgut Ton")).toBe("ostgutton");
    expect(normalisedNameKey("Brutaż")).toBe("brutaz");
  });
  it("keeps digits", () => {
    expect(normalisedNameKey("3MOON Records")).toBe("3moonrecords");
  });
  it("is empty for punctuation-only input", () => {
    expect(normalisedNameKey("???")).toBe("");
    expect(normalisedNameKey("")).toBe("");
  });
});

describe("initialOrganisationRows", () => {
  const entry = (id: string, name: string, r = ASSOCIATED) => ({
    organisation: { id, name },
    role: r,
  });

  it("carries an attached organisation's id", () => {
    expect(initialOrganisationRows([entry("o1", "Ostgut Ton")], [])).toEqual([
      { id: "o1", name: "Ostgut Ton" },
    ]);
  });

  it("includes flat labels that have no organisation yet", () => {
    expect(initialOrganisationRows([], [{ name: "Trip Records" }])).toEqual([
      { id: null, name: "Trip Records" },
    ]);
  });

  it("shows a name present in both sources once, with its id", () => {
    // The normal mid-migration state: the organisation exists, and the
    // artist_labels row is still there for the dual-read fallback.
    const rows = initialOrganisationRows(
      [entry("o1", "Ostgut Ton")],
      [{ name: "ostgut-ton" }],
    );
    expect(rows).toEqual([{ id: "o1", name: "Ostgut Ton" }]);
  });

  it("ignores roles this field doesn't manage", () => {
    const rows = initialOrganisationRows(
      [entry("o1", "PAN", { key: "head", label: "head", sort_order: 20 })],
      [],
    );
    expect(rows).toEqual([{ id: null, name: "" }]);
  });

  it("always returns at least one empty row to type into", () => {
    expect(initialOrganisationRows([], [])).toEqual([{ id: null, name: "" }]);
    expect(initialOrganisationRows(undefined, undefined)).toEqual([{ id: null, name: "" }]);
  });
});

describe("initialOrganisationRowsWithRoles", () => {
  const entry = (id: string, name: string, r = ASSOCIATED) => ({
    organisation: { id, name },
    role: r,
  });

  it("shows roles the associated-only seeding hides", () => {
    // The defect this exists to fix: an artist who is `head` of an
    // organisation saw NOTHING for it on the admin edit form, while their
    // public page rendered "Head: …".
    const rows = initialOrganisationRowsWithRoles([entry("o1", "PAN", HEAD)], []);
    expect(rows).toEqual([{ id: "o1", name: "PAN", role_key: "head" }]);
    // …whereas the public-form seeding still filters it out.
    expect(initialOrganisationRows([entry("o1", "PAN", HEAD)], [])).toEqual([
      { id: null, name: "" },
    ]);
  });

  it("gives one organisation a row per role", () => {
    const rows = initialOrganisationRowsWithRoles(
      [entry("o1", "Tresor", ASSOCIATED), entry("o1", "Tresor", RESIDENT)],
      [],
    );
    expect(rows.map((r) => r.role_key)).toEqual(["associated", "resident"]);
  });

  it("defaults an unresolved flat label to the associated role", () => {
    expect(initialOrganisationRowsWithRoles([], [{ name: "Trip Records" }])).toEqual([
      { id: null, name: "Trip Records", role_key: "associated" },
    ]);
  });

  it("drops a flat label whose organisation is already attached in any role", () => {
    // The dual-read's redundant copy, not a second thing to edit.
    const rows = initialOrganisationRowsWithRoles(
      [entry("o1", "PAN", HEAD)],
      [{ name: "pan" }],
    );
    expect(rows).toEqual([{ id: "o1", name: "PAN", role_key: "head" }]);
  });

  it("always returns at least one empty row", () => {
    expect(initialOrganisationRowsWithRoles([], [])).toEqual([
      { id: null, name: "", role_key: "associated" },
    ]);
  });
});
