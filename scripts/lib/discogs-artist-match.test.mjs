import { describe, it, expect } from "vitest";
import {
  discogsArtistIdFromUrl,
  buildDiscogsIdIndex,
  decide,
  matchDiscogsArtists,
} from "./discogs-artist-match.mjs";

// A stand-in for makeFetchAll()'s fetchAll over canned tables: builds the
// same chainable query object the real one hands to applyFilters, then
// applies the recorded eq/in filters in JS.
function fakeFetchAll(tables) {
  return async function fetchAll(table, _select, applyFilters = (q) => q) {
    const filters = [];
    const query = {
      eq: (col, value) => (filters.push(["eq", col, value]), query),
      in: (col, values) => (filters.push(["in", col, values]), query),
    };
    applyFilters(query);
    return (tables[table] ?? []).filter((row) =>
      filters.every(([kind, col, value]) =>
        kind === "eq" ? row[col] === value : value.includes(row[col])
      )
    );
  };
}

describe("discogsArtistIdFromUrl", () => {
  it("reads the id out of every URL shape the table actually holds", () => {
    expect(discogsArtistIdFromUrl("https://www.discogs.com/artist/21748")).toBe("21748");
    expect(discogsArtistIdFromUrl("https://www.discogs.com/artist/5119514-Amelie-Lens")).toBe("5119514");
    expect(discogsArtistIdFromUrl("https://www.discogs.com/fr/artist/10587874-Audrey-Danza")).toBe("10587874");
    expect(discogsArtistIdFromUrl("http://discogs.com/artist/3947-Ben-Sims")).toBe("3947");
  });

  it("returns null for links that aren't a numeric artist URL", () => {
    expect(discogsArtistIdFromUrl("http://discogs.com/artist/Bruno+Pronsato")).toBeNull();
    expect(discogsArtistIdFromUrl("https://www.discogs.com/label/1480511-Lenske-Records")).toBeNull();
    expect(discogsArtistIdFromUrl("https://www.discogs.com/fr/user/fantomask")).toBeNull();
    expect(discogsArtistIdFromUrl(null)).toBeNull();
  });
});

describe("buildDiscogsIdIndex", () => {
  it("keys artists by discogs id and dedupes repeated links", () => {
    const index = buildDiscogsIdIndex([
      { artist_id: "a", url: "https://www.discogs.com/artist/3947-Ben-Sims" },
      { artist_id: "a", url: "https://www.discogs.com/fr/artist/3947" },
      { artist_id: "b", url: "https://www.discogs.com/artist/3947" },
      { artist_id: "c", url: "https://www.discogs.com/label/843-Hardgroove" },
    ]);
    expect(index.get("3947")).toEqual(["a", "b"]);
    expect(index.size).toBe(1);
  });
});

describe("decide", () => {
  it("treats one candidate as a match and several as an ambiguity", () => {
    const one = [{ id: "a", name: "Tino" }];
    const two = [...one, { id: "b", name: "TINO" }];
    expect(decide(one, "name")).toMatchObject({ method: "name", id: "a", name: "Tino" });
    expect(decide(two, "name")).toMatchObject({ method: "name_ambiguous", id: null, name: null });
    expect(decide([], "link")).toMatchObject({ method: null, id: null, name: null });
  });
});

describe("matchDiscogsArtists", () => {
  const tables = {
    artist_links: [
      { artist_id: "a1", url: "https://www.discogs.com/artist/3947-Ben-Sims", platform: "discogs", not_found: false },
      { artist_id: "a2", url: "https://www.discogs.com/fr/artist/1735", platform: "discogs", not_found: false },
      { artist_id: "a3", url: "https://www.discogs.com/artist/999-Ghost", platform: "discogs", not_found: false },
      { artist_id: "a4", url: "https://www.discogs.com/artist/555-Rejected", platform: "discogs", not_found: true },
      { artist_id: "a5", url: "https://soundcloud.com/someone", platform: "soundcloud", not_found: false },
    ],
    artists: [
      { id: "a1", name: "Ben Sims", name_search: "bensims", deleted: false },
      { id: "a2", name: "Paul Mac", name_search: "paulmac", deleted: false },
      { id: "a3", name: "Ghost", name_search: "ghost", deleted: true },
      { id: "a4", name: "Rejected", name_search: "rejected", deleted: false },
      { id: "n1", name: "A.M.", name_search: "am", deleted: false },
      { id: "d1", name: "Tino", name_search: "tino", deleted: false },
      { id: "d2", name: "TINO", name_search: "tino", deleted: false },
    ],
  };

  it("matches on the link first, then on the normalized name", async () => {
    const results = await matchDiscogsArtists({
      fetchAll: fakeFetchAll(tables),
      artists: [
        { key: "k-sims", name: "Ben Sims", discogsId: 3947 },
        { key: "k-mac", name: "Paul Mac", discogsId: 1735 },
        { key: "k-am", name: "A M", discogsId: 40404 },
        { key: "k-tino", name: "Tino", discogsId: 50505 },
        { key: "k-ghost", name: "Ghost", discogsId: 999 },
        { key: "k-rejected", name: "Rejected!", discogsId: 555 },
        { key: "k-none", name: "Nobody At All", discogsId: 60606 },
      ],
    });

    // 1. link match, whatever shape the stored URL takes
    expect(results.get("k-sims")).toMatchObject({ method: "link", id: "a1", name: "Ben Sims" });
    expect(results.get("k-mac")).toMatchObject({ method: "link", id: "a2", name: "Paul Mac" });
    // 2. name match: punctuation and spaces are stripped both sides
    expect(results.get("k-am")).toMatchObject({ method: "name", id: "n1", name: "A.M." });
    // a not_found link is not identity, but the name behind it still matches
    expect(results.get("k-rejected")).toMatchObject({ method: "name", id: "a4" });
    // a soft-deleted artist is invisible to both steps
    expect(results.get("k-ghost")).toMatchObject({ method: null, id: null, name: null });
    // two live artists share the name key: no artist is chosen
    expect(results.get("k-tino")).toMatchObject({ method: "name_ambiguous", id: null, name: null });
    expect(results.get("k-tino").candidates.map((c) => c.id)).toEqual(["d1", "d2"]);
    // nothing at all
    expect(results.get("k-none")).toMatchObject({ method: null, id: null, name: null });
  });

  it("prefers the link even when a different artist shares the name", async () => {
    const results = await matchDiscogsArtists({
      fetchAll: fakeFetchAll(tables),
      artists: [{ key: "k", name: "Tino", discogsId: 3947 }],
    });
    expect(results.get("k")).toMatchObject({ method: "link", id: "a1" });
  });
});
