import { describe, it, expect } from "vitest";
import {
  cleanBio,
  termUpsertFromAuthor,
  termUpsertFromPpmaTerm,
  distinctTermIds,
  buildAuthorIndex,
  genreStageRows,
  slugFromArtistUrl,
} from "./hoer-seed.mjs";

describe("cleanBio", () => {
  it("strips tags, decodes entities, and trims", () => {
    expect(cleanBio("<p>Hard &amp; fast</p>")).toBe("Hard & fast");
    expect(cleanBio("line one<br>line two")).toBe("line one\nline two");
  });
  it("returns null for empty / whitespace / null", () => {
    expect(cleanBio("")).toBeNull();
    expect(cleanBio("   \n ")).toBeNull();
    expect(cleanBio(null)).toBeNull();
  });
  it("keeps a plain bio with a trailing newline clean", () => {
    expect(cleanBio("GMOZ is an Australian Producer/DJ\n")).toBe("GMOZ is an Australian Producer/DJ");
  });
});

describe("termUpsertFromAuthor", () => {
  const seen = "2026-07-22T00:00:00Z";

  it("maps a full author, coercing types and omitting the binding columns", () => {
    const row = termUpsertFromAuthor(
      {
        term_id: 14628,
        user_id: 233733,
        is_guest: 0,
        slug: "gmoz",
        display_name: "GMOZ",
        first_name: "Georgia",
        last_name: "Morrow",
        description: "high energy",
      },
      seen
    );
    expect(row).toEqual({
      term_id: 14628,
      slug: "gmoz",
      display_name: "GMOZ",
      first_name: "Georgia",
      last_name: "Morrow",
      bio: "high energy",
      wp_user_id: 233733,
      is_guest: false,
      last_seen_at: seen,
    });
    // No binding / scrape columns leak in — the upsert must not clobber them.
    for (const k of ["artist_id", "bound_at", "bind_method", "scraped_at", "image_url", "first_seen_at"]) {
      expect(row).not.toHaveProperty(k);
    }
  });

  it("nulls empty names and bio, and marks a guest", () => {
    const row = termUpsertFromAuthor(
      { term_id: 14883, slug: "romsy1", display_name: "Romsy", first_name: "", last_name: "  ", description: "", is_guest: 1, user_id: 0 },
      seen
    );
    expect(row.first_name).toBeNull();
    expect(row.last_name).toBeNull();
    expect(row.bio).toBeNull();
    expect(row.is_guest).toBe(true);
    expect(row.wp_user_id).toBeNull();
  });

  it("returns null without a term_id or slug", () => {
    expect(termUpsertFromAuthor({ slug: "x" }, seen)).toBeNull();
    expect(termUpsertFromAuthor({ term_id: 1 }, seen)).toBeNull();
    expect(termUpsertFromAuthor(null, seen)).toBeNull();
  });
});

describe("termUpsertFromPpmaTerm", () => {
  it("uses name as best-effort display_name and nulls the rest", () => {
    expect(termUpsertFromPpmaTerm({ id: 12361, slug: "posi-flo-2", name: "Posi Flo" }, "t")).toEqual({
      term_id: 12361,
      slug: "posi-flo-2",
      display_name: "Posi Flo",
      first_name: null,
      last_name: null,
      bio: null,
      wp_user_id: null,
      is_guest: null,
      last_seen_at: "t",
    });
  });
});

describe("distinctTermIds", () => {
  it("flattens and dedupes term ids across sets, order-preserving", () => {
    expect(
      distinctTermIds([{ term_ids: [1, 2] }, { term_ids: [2, 3] }, { term_ids: [] }, {}])
    ).toEqual([1, 2, 3]);
  });
});

describe("buildAuthorIndex", () => {
  it("keeps the first slugged author per term id", () => {
    const idx = buildAuthorIndex([
      { authors: [{ term_id: 1, slug: "a", display_name: "A" }] },
      { authors: [{ term_id: 1, slug: "a", display_name: "A2" }, { term_id: 2, slug: "b" }] },
    ]);
    expect(idx.get(1).display_name).toBe("A");
    expect(idx.get(2).slug).toBe("b");
    expect(idx.size).toBe(2);
  });
  it("skips authors with no slug (fallback resolves those)", () => {
    const idx = buildAuthorIndex([{ authors: [{ term_id: 9, display_name: "no slug" }] }]);
    expect(idx.has(9)).toBe(false);
  });
});

describe("genreStageRows", () => {
  const tagMap = new Map([
    [10, "Techno"],
    [11, "Ambient"],
    [12, ""], // unnamed tag → skipped
  ]);

  it("applies a set's tags to each bound artist on it, deduped", () => {
    const termToArtist = new Map([
      [1, "art-A"],
      [2, "art-B"],
    ]);
    const rows = genreStageRows(
      [
        { term_ids: [1, 2], tag_ids: [10, 11] },
        { term_ids: [1], tag_ids: [10] }, // duplicate (art-A, techno)
      ],
      termToArtist,
      tagMap
    );
    expect(rows).toContainEqual({ artist_id: "art-A", source_platform: "hoer", raw_tag: "techno" });
    expect(rows).toContainEqual({ artist_id: "art-A", source_platform: "hoer", raw_tag: "ambient" });
    expect(rows).toContainEqual({ artist_id: "art-B", source_platform: "hoer", raw_tag: "techno" });
    expect(rows).toContainEqual({ artist_id: "art-B", source_platform: "hoer", raw_tag: "ambient" });
    expect(rows).toHaveLength(4); // the duplicate collapsed
  });

  it("ignores unbound terms and unnamed tags", () => {
    const termToArtist = new Map([[1, "art-A"]]);
    const rows = genreStageRows([{ term_ids: [1, 99], tag_ids: [10, 12] }], termToArtist, tagMap);
    expect(rows).toEqual([{ artist_id: "art-A", source_platform: "hoer", raw_tag: "techno" }]);
  });

  it("stages nothing when no term on the set is bound", () => {
    expect(genreStageRows([{ term_ids: [99], tag_ids: [10] }], new Map(), tagMap)).toEqual([]);
  });
});

describe("slugFromArtistUrl", () => {
  it("extracts and lowercases the slug", () => {
    expect(slugFromArtistUrl("https://hoer.live/artist/Posi-Flo-2/")).toBe("posi-flo-2");
  });
  it("returns null for a non-artist URL", () => {
    expect(slugFromArtistUrl("https://hoer.live/some-set/")).toBeNull();
    expect(slugFromArtistUrl(null)).toBeNull();
  });
});
