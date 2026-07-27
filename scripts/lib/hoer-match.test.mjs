import { describe, it, expect } from "vitest";
import {
  MATCH_POOL_PLATFORMS,
  hasMeaningfulPath,
  eligibleMatchLinks,
  decideOutcome,
} from "./hoer-match.mjs";

describe("hasMeaningfulPath", () => {
  it("is true for a handle/id path", () => {
    expect(hasMeaningfulPath("https://soundcloud.com/gmoz")).toBe(true);
    expect(hasMeaningfulPath("https://discogs.com/artist/1108-DJ-T-1000")).toBe(true);
  });
  it("is false for a bare host or root path", () => {
    expect(hasMeaningfulPath("https://bandcamp.com/")).toBe(false);
    expect(hasMeaningfulPath("https://soundcloud.com")).toBe(false);
  });
  it("is false for unparseable input", () => {
    expect(hasMeaningfulPath("not a url")).toBe(false);
    expect(hasMeaningfulPath(null)).toBe(false);
  });
});

describe("eligibleMatchLinks", () => {
  it("keeps pool platforms with a meaningful path, drops the rest", () => {
    const links = [
      { parsed_platform: "soundcloud", parsed_url: "https://soundcloud.com/gmoz" },
      { parsed_platform: "bandcamp", parsed_url: "https://bandcamp.com/" }, // bare host
      { parsed_platform: "youtube", parsed_url: "https://youtube.com/watch?v=x" }, // not pool
      { parsed_platform: "other", parsed_url: "https://example.com/x" }, // not pool
      { parsed_platform: "instagram", parsed_url: "https://instagram.com/gmoz" },
    ];
    expect(eligibleMatchLinks(links).map((l) => l.parsed_platform)).toEqual([
      "soundcloud",
      "instagram",
    ]);
  });
  it("handles empty / missing input", () => {
    expect(eligibleMatchLinks([])).toEqual([]);
    expect(eligibleMatchLinks(undefined)).toEqual([]);
  });
  it("pool excludes the non-identity platforms", () => {
    expect(MATCH_POOL_PLATFORMS.has("linktree")).toBe(false);
    expect(MATCH_POOL_PLATFORMS.has("youtube")).toBe(false);
    expect(MATCH_POOL_PLATFORMS.has("other")).toBe(false);
    expect(MATCH_POOL_PLATFORMS.has("soundcloud")).toBe(true);
  });
});

describe("decideOutcome", () => {
  it("seeds when nothing matched", () => {
    expect(decideOutcome([])).toEqual({ type: "seed" });
  });
  it("binds to the single matched artist (deduping repeats across links)", () => {
    expect(decideOutcome(["art-A", "art-A"])).toEqual({ type: "bind", artistId: "art-A" });
  });
  it("is ambiguous when >1 distinct artist matched", () => {
    const out = decideOutcome(["art-A", "art-B", "art-A"]);
    expect(out.type).toBe("ambiguous");
    expect([...out.artistIds].sort()).toEqual(["art-A", "art-B"]);
  });
});
