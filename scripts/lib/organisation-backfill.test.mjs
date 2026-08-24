import { describe, it, expect } from "vitest";
import {
  pickCanonicalName,
  groupOrganisations,
  hasSeparator,
  looksLikePronouns,
  pronounMatch,
  findNearDuplicates,
  findArtistNameCollisions,
  buildAmbiguityReport,
  isHandledByLabelEtcPass,
} from "./organisation-backfill.mjs";

const entry = (artistId, rawName, source = "artist_labels") => ({ artistId, rawName, source });

describe("pickCanonicalName", () => {
  it("takes the most common surface form", () => {
    expect(
      pickCanonicalName([
        { name: "bpitch control", count: 2 },
        { name: "BPitch Control", count: 39 },
      ]),
    ).toBe("BPitch Control");
  });
  it("breaks a tie towards the hand-typed mixed-case form", () => {
    expect(
      pickCanonicalName([
        { name: "ostgut ton", count: 3 },
        { name: "OSTGUT TON", count: 3 },
        { name: "Ostgut Ton", count: 3 },
      ]),
    ).toBe("Ostgut Ton");
  });
  it("still prefers a capital to none when no form is mixed case", () => {
    expect(
      pickCanonicalName([
        { name: "tresor", count: 1 },
        { name: "TRESOR", count: 1 },
      ]),
    ).toBe("TRESOR");
  });
  it("breaks a remaining tie lexicographically, so the result is stable", () => {
    const forms = [
      { name: "Tresor Berlin", count: 1 },
      { name: "Tresor berlin", count: 1 },
    ];
    expect(pickCanonicalName(forms)).toBe(pickCanonicalName([...forms].reverse()));
  });
  it("returns an empty string for no forms", () => {
    expect(pickCanonicalName([])).toBe("");
  });
});

describe("groupOrganisations", () => {
  it("collapses spellings that share a normalised key", () => {
    const { groups } = groupOrganisations([
      entry("a1", "Ostgut Ton"),
      entry("a2", "ostgut-ton"),
      entry("a3", "OSTGUT  TON"),
    ]);
    expect(groups.size).toBe(1);
    const group = groups.get("ostgutton");
    expect(group.entries).toHaveLength(3);
    expect(group.surfaceForms).toHaveLength(3);
    expect(group.canonicalName).toBe("Ostgut Ton");
  });

  it("keeps genuinely different names apart", () => {
    const { groups } = groupOrganisations([entry("a1", "Tresor"), entry("a2", "Ostgut Ton")]);
    expect([...groups.keys()].sort()).toEqual(["ostgutton", "tresor"]);
  });

  it("normalises away accents, so Möbel matches Mobel", () => {
    const { groups } = groupOrganisations([entry("a1", "Möbel"), entry("a2", "Mobel")]);
    expect(groups.size).toBe(1);
  });

  it("hands back entries that normalise to nothing instead of dropping them", () => {
    const { groups, unnamed } = groupOrganisations([entry("a1", "???"), entry("a2", "Tresor")]);
    expect(groups.size).toBe(1);
    expect(unnamed).toEqual([entry("a1", "???")]);
  });

  it("counts one surface form per occurrence", () => {
    const { groups } = groupOrganisations([
      entry("a1", "DNB Girls"),
      entry("a2", "DNB Girls"),
      entry("a3", "dnb girls"),
    ]);
    expect(groups.get("dnbgirls").surfaceForms).toEqual(
      expect.arrayContaining([
        { name: "DNB Girls", count: 2 },
        { name: "dnb girls", count: 1 },
      ]),
    );
  });
});

describe("hasSeparator", () => {
  it("flags slashes and spaced ampersands/pluses", () => {
    expect(hasSeparator("Live From Earth / Klub")).toBe(true);
    expect(hasSeparator("Tresor & Ostgut")).toBe(true);
    expect(hasSeparator("Tresor + Ostgut")).toBe(true);
    expect(hasSeparator("Tresor x Ostgut")).toBe(true);
  });
  it("leaves unspaced ampersands alone — they belong to the name", () => {
    expect(hasSeparator("R&S Records")).toBe(false);
    expect(hasSeparator("Nu+Ra")).toBe(false);
  });
  it("is false for a plain name", () => {
    expect(hasSeparator("BPitch Control")).toBe(false);
    expect(hasSeparator(null)).toBe(false);
  });
});

describe("looksLikePronouns", () => {
  it("catches the she/they row typed into the label field", () => {
    expect(looksLikePronouns("she/they")).toBe(true);
    expect(looksLikePronouns("She / Her")).toBe(true);
    expect(looksLikePronouns("they/them")).toBe(true);
  });
  it("does not fire on an organisation that merely contains a pronoun word", () => {
    expect(looksLikePronouns("They Never Sleep Records")).toBe(false);
    expect(looksLikePronouns("Her Records")).toBe(false);
  });
  it("matches wordings supplied from the pronouns table", () => {
    const known = new Set(["anypronouns"]);
    expect(looksLikePronouns("any pronouns", known)).toBe(true);
  });
  it("separates a token match from a pronouns-table-only match", () => {
    expect(pronounMatch("she/they")).toBe("tokens");
    // Production really does have a pronouns row reading "BØX collectif":
    // there it is the pronouns field that was filled in wrongly, not this one.
    expect(pronounMatch("BØX Collectif", new Set(["boxcollectif"]))).toBe("vocabulary");
    expect(pronounMatch("Tresor")).toBe(null);
  });
  it("prefers the token reading when a pronoun is also in the table", () => {
    expect(pronounMatch("she/her", new Set(["sheher"]))).toBe("tokens");
  });
  it("is false for blank input", () => {
    expect(looksLikePronouns("")).toBe(false);
    expect(looksLikePronouns(null)).toBe(false);
  });
});

describe("findNearDuplicates", () => {
  it("pairs keys that are close but not equal", () => {
    const { groups } = groupOrganisations([
      entry("a1", "Ostgut Ton"),
      entry("a2", "Ostgut Ton Berlin"),
      entry("a3", "Tresor"),
    ]);
    const pairs = findNearDuplicates(groups, { threshold: 0.5 });
    expect(pairs).toHaveLength(1);
    expect([pairs[0].a.key, pairs[0].b.key].sort()).toEqual(["ostgutton", "ostguttonberlin"]);
  });
  it("returns nothing when every name is distinct", () => {
    const { groups } = groupOrganisations([entry("a1", "Tresor"), entry("a2", "BPitch Control")]);
    expect(findNearDuplicates(groups, { threshold: 0.6 })).toEqual([]);
  });
});

describe("findArtistNameCollisions", () => {
  it("finds the person and the organisation sharing a name", () => {
    const { groups } = groupOrganisations([entry("a1", "Discwoman"), entry("a2", "Tresor")]);
    const artistsByKey = new Map([
      ["discwoman", [{ id: "art-1", name: "Discwoman", directory_status: "approved" }]],
    ]);
    const collisions = findArtistNameCollisions(groups, artistsByKey);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].group.key).toBe("discwoman");
  });
});

describe("buildAmbiguityReport", () => {
  it("reports each kind of thing a reviewer has to decide", () => {
    const { groups } = groupOrganisations([
      entry("a1", "she/they"),
      entry("a2", "Live From Earth / Klub"),
      entry("a3", "Ostgut Ton"),
      entry("a4", "ostgut ton"),
      entry("a5", "Ostgut Ton Berlin"),
      entry("a6", "Discwoman"),
    ]);
    const rows = buildAmbiguityReport(groups, {
      artistsByKey: new Map([
        ["discwoman", [{ id: "art-1", name: "Discwoman", directory_status: "approved" }]],
      ]),
      threshold: 0.5,
    });
    const reasons = new Set(rows.map((r) => r.reason));
    expect(reasons).toEqual(
      new Set([
        "pronouns_in_label",
        "separator_in_name",
        "multiple_surface_forms",
        "name_collides_with_artist",
        "near_duplicate",
      ]),
    );
  });

  it("puts the rows needing judgement above the bulk ones", () => {
    const { groups } = groupOrganisations([
      entry("a1", "Wet Trax"),
      entry("a2", "she/they"),
    ]);
    const rows = buildAmbiguityReport(groups, {
      artistsByKey: new Map([
        ["wettrax", [{ id: "art-2", name: "WET TRAX", directory_status: "sc_followee" }]],
      ]),
    });
    expect(rows.map((r) => r.reason)).toEqual([
      "pronouns_in_label",
      "name_matches_unreviewed_artist",
    ]);
  });

  it("stays quiet about artists already marked label_etc", () => {
    // Setting an artist to 'label_etc' IS the resolution of a
    // name_matches_unreviewed_artist row — pass 2 takes it from there —
    // so re-reporting it would hand the reviewer back their own work.
    expect(isHandledByLabelEtcPass("label_etc")).toBe(true);
    expect(isHandledByLabelEtcPass("sc_followee")).toBe(false);
    expect(isHandledByLabelEtcPass("approved")).toBe(false);
  });

  it("distinguishes a directory artist from an unreviewed import", () => {
    const { groups } = groupOrganisations([entry("a1", "Discwoman"), entry("a2", "Wet Trax")]);
    const rows = buildAmbiguityReport(groups, {
      artistsByKey: new Map([
        ["discwoman", [{ id: "art-1", name: "Discwoman", directory_status: "approved" }]],
        ["wettrax", [{ id: "art-2", name: "WET TRAX", directory_status: "sc_followee" }]],
      ]),
    });
    expect(rows.find((r) => r.key === "discwoman").reason).toBe("name_collides_with_artist");
    expect(rows.find((r) => r.key === "wettrax").reason).toBe("name_matches_unreviewed_artist");
  });

  it("classifies she/they as pronouns rather than as a separator", () => {
    const { groups } = groupOrganisations([entry("a1", "she/they")]);
    const rows = buildAmbiguityReport(groups, {});
    expect(rows.map((r) => r.reason)).toEqual(["pronouns_in_label"]);
  });

  it("is empty for clean, distinct data", () => {
    const { groups } = groupOrganisations([entry("a1", "Tresor"), entry("a2", "BPitch Control")]);
    expect(buildAmbiguityReport(groups, {})).toEqual([]);
  });
});
