import { describe, it, expect } from "vitest";
import {
  unaccent,
  normalizeName,
  trigrams,
  nameSimilarity,
  parsePronounTokens,
  isHeHim,
  countToken,
  detectPronoun,
  pronounDecision,
  bioTokens,
  bioOverlap,
  normalizeGenre,
  genreOverlap,
  parseCSV,
  toCSV,
  timestamp,
} from "./hoer-resolve.mjs";

// Mirror of what the post-migration name_search column produces, used to
// keep the Node normalizer and the DB expression in lock-step conceptually.
describe("normalizeName", () => {
  it("lowercases, strips diacritics, spaces and punctuation", () => {
    expect(normalizeName("Åsa Bäck")).toBe("asaback");
    expect(normalizeName("A.M. 2000")).toBe("am2000");
    expect(normalizeName("DJ Süß!")).toBe("djsuss");
    expect(normalizeName("René—Marie")).toBe("renemarie");
  });

  it("folds non-decomposable Latin letters like Postgres unaccent", () => {
    expect(normalizeName("Bjørn")).toBe("bjorn");
    expect(normalizeName("Straße")).toBe("strasse");
    expect(normalizeName("Æther")).toBe("aether");
  });

  it("drops characters that unaccent can't romanize (non-Latin scripts)", () => {
    // The DB expression removes all non [a-z0-9]; so does this.
    expect(normalizeName("東京")).toBe("");
    expect(normalizeName("Иван")).toBe("");
  });

  it("returns empty string for non-strings", () => {
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
  });
});

describe("unaccent", () => {
  it("romanizes common accented Latin letters", () => {
    expect(unaccent("café")).toBe("cafe");
    expect(unaccent("naïve")).toBe("naive");
    expect(unaccent("Zürich")).toBe("Zurich");
  });
});

describe("trigrams / nameSimilarity", () => {
  it("produces pg_trgm-style padded trigrams", () => {
    expect(trigrams("cat")).toEqual(new Set(["  c", " ca", "cat", "at "]));
  });

  it("scores identical names 1 and disjoint names low", () => {
    expect(nameSimilarity("aphextwin", "aphextwin")).toBe(1);
    expect(nameSimilarity("ayakomori", "ayakomori2")).toBeGreaterThan(0.6);
    expect(nameSimilarity("björk", "metallica")).toBeLessThan(0.2);
  });

  it("returns 0 when either side is empty", () => {
    expect(nameSimilarity("", "foo")).toBe(0);
    expect(nameSimilarity("foo", "")).toBe(0);
  });
});

describe("parsePronounTokens / isHeHim", () => {
  it("splits on slashes and whitespace, lowercased", () => {
    expect(parsePronounTokens("she/her")).toEqual(["she", "her"]);
    expect(parsePronounTokens("She / They")).toEqual(["she", "they"]);
    expect(parsePronounTokens("they/them")).toEqual(["they", "them"]);
  });

  it("identifies the he/him set regardless of ordering", () => {
    expect(isHeHim(["he", "him"])).toBe(true);
    expect(isHeHim(["him", "he"])).toBe(true);
    expect(isHeHim(["he", "they"])).toBe(false);
    expect(isHeHim(["she", "her"])).toBe(false);
  });
});

describe("countToken", () => {
  it("counts word-boundary case-insensitive occurrences", () => {
    expect(countToken("She is great. She DJs.", "she")).toBe(2);
    expect(countToken("theyself theory", "they")).toBe(0); // no false substrings
    expect(countToken("he/they", "he")).toBe(1);
    expect(countToken("he/they", "they")).toBe(1);
  });
});

const PRONOUNS = [
  { id: 1, value: "she/her" },
  { id: 2, value: "he/him" },
  { id: 3, value: "they/them" },
  { id: 4, value: "she/they" },
];

describe("detectPronoun / pronounDecision", () => {
  it("approves a clear she/her bio", () => {
    const d = detectPronoun("She is a producer. Her live sets tour widely.", PRONOUNS);
    expect(d.dominant.value).toBe("she/her");
    expect(d.dominanceRatio).toBe(1);
    const dec = pronounDecision(d);
    expect(dec.decision).toBe("approved");
    expect(dec.pronounId).toBe(1);
  });

  it("marks a clear he/him bio not_eligible", () => {
    const d = detectPronoun("He is a producer. Follow him.", PRONOUNS);
    expect(d.dominant.value).toBe("he/him");
    const dec = pronounDecision(d);
    expect(dec.decision).toBe("not_eligible");
    expect(dec.pronounId).toBe(2);
  });

  it("approves on a single pronoun mention", () => {
    const d = detectPronoun("She runs the label.", PRONOUNS);
    expect(d.dominanceRatio).toBe(1);
    expect(pronounDecision(d).decision).toBe("approved");
  });

  it("leaves a mixed he/they bio pending (never reaches 0.80 on he/him)", () => {
    const d = detectPronoun("Pronouns: he/they.", PRONOUNS);
    expect(d.dominanceRatio).toBeLessThan(0.8);
    expect(pronounDecision(d).decision).toBe("pending");
  });

  it("treats exactly 0.80 dominance as eligible (>= threshold)", () => {
    // "she" x4, "he" x1 -> she/her hits 4, total 5 -> ratio 0.80.
    const bio = "She she she she. He.";
    const d = detectPronoun(bio, PRONOUNS);
    expect(d.dominant.value).toBe("she/her");
    expect(d.dominanceRatio).toBeCloseTo(0.8, 10);
    expect(pronounDecision(d).decision).toBe("approved");
  });

  it("stays just under 0.80 -> pending", () => {
    // "she" x3, "he" x1 -> ratio 0.75.
    const d = detectPronoun("She she she. He.", PRONOUNS);
    expect(d.dominanceRatio).toBeCloseTo(0.75, 10);
    expect(pronounDecision(d).decision).toBe("pending");
  });

  it("returns pending when no pronouns are found", () => {
    const d = detectPronoun("An anonymous collective from Leipzig.", PRONOUNS);
    expect(d.dominant).toBeNull();
    expect(d.dominanceRatio).toBe(0);
    expect(pronounDecision(d).decision).toBe("pending");
  });
});

describe("bioTokens / bioOverlap", () => {
  it("strips stop words and short tokens", () => {
    const t = bioTokens("She is a techno producer from Leipzig");
    expect(t.has("techno")).toBe(true);
    expect(t.has("leipzig")).toBe(true);
    expect(t.has("is")).toBe(false);
    expect(t.has("producer")).toBe(false); // domain stop word
  });

  it("scores Jaccard overlap between two bios", () => {
    const o = bioOverlap(
      "Ambient techno artist exploring modular synthesis",
      "Modular synthesis and ambient techno explorations"
    );
    expect(o.shared).toBeGreaterThan(0);
    expect(o.jaccard).toBeGreaterThan(0.4);
  });

  it("returns zero overlap when either bio is empty", () => {
    expect(bioOverlap("", "techno")).toEqual({ jaccard: 0, shared: 0 });
  });
});

describe("normalizeGenre / genreOverlap", () => {
  it("normalizes punctuation and case before comparing", () => {
    expect(normalizeGenre("Lo-Fi")).toBe("lofi");
    const o = genreOverlap(["Lo-Fi", "Techno"], ["lo fi", "house"]);
    expect(o.count).toBe(1);
    expect(o.shared).toContain("lofi");
  });

  it("returns empty overlap for disjoint sets", () => {
    expect(genreOverlap(["techno"], ["jazz"]).count).toBe(0);
  });
});

describe("CSV round-trip", () => {
  it("writes and re-reads rows, preserving commas, quotes and newlines", () => {
    const columns = ["artist_id", "hoer_name", "evidence"];
    const rows = [
      { artist_id: "abc", hoer_name: "Foo, Bar", evidence: 'has "quotes"' },
      { artist_id: "def", hoer_name: "line\nbreak", evidence: "" },
    ];
    const csv = toCSV(columns, rows);
    const parsed = parseCSV(csv);
    expect(parsed).toEqual([
      { artist_id: "abc", hoer_name: "Foo, Bar", evidence: 'has "quotes"' },
      { artist_id: "def", hoer_name: "line\nbreak", evidence: "" },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCSV("")).toEqual([]);
  });
});

describe("timestamp", () => {
  it("formats YYYYMMDD-HHMMSS", () => {
    const stamp = timestamp(new Date(2026, 6, 11, 9, 5, 3));
    expect(stamp).toBe("20260711-090503");
  });
});
