import { describe, it, expect } from "vitest";
import { normalizeForComparison, urlsMatch } from "./link-url-match.mjs";

describe("urlsMatch", () => {
  it("ignores http vs https", () => {
    expect(urlsMatch("http://x.com/a", "https://x.com/a")).toBe(true);
  });

  it("ignores a trailing slash on either side", () => {
    expect(urlsMatch("https://x.com/a", "https://x.com/a/")).toBe(true);
  });

  it("ignores a www. prefix on either side", () => {
    expect(urlsMatch("https://instagram.com/a", "https://www.instagram.com/a")).toBe(true);
  });

  it("ignores hostname case", () => {
    expect(urlsMatch("https://Instagram.com/a", "https://instagram.com/a")).toBe(true);
  });

  it("ignores known tracking and share params", () => {
    expect(
      urlsMatch("https://open.spotify.com/artist/1?si=abc&nd=1", "https://open.spotify.com/artist/1")
    ).toBe(true);
    expect(urlsMatch("https://instagram.com/a?igshid=xyz", "https://instagram.com/a")).toBe(true);
  });

  it("keeps meaningful query params", () => {
    expect(urlsMatch("https://x.com/a?page=2", "https://x.com/a")).toBe(false);
  });

  it("treats different paths as different links", () => {
    expect(urlsMatch("https://x.com/a", "https://x.com/b")).toBe(false);
  });

  it("treats different hosts as different links", () => {
    expect(urlsMatch("https://a.bandcamp.com", "https://b.bandcamp.com")).toBe(false);
  });

  it("does not fold path case — paths are case-sensitive by spec", () => {
    expect(urlsMatch("https://discogs.com/artist/1-Nala", "https://discogs.com/artist/1-nala"))
      .toBe(false);
  });

  it("keeps the bare root path matching its slashed form", () => {
    expect(urlsMatch("https://x.bandcamp.com", "https://x.bandcamp.com/")).toBe(true);
  });

  it("falls back to string equality for unparseable values", () => {
    expect(urlsMatch("not a url", "not a url")).toBe(true);
    expect(urlsMatch("not a url", "also not a url")).toBe(false);
  });
});

describe("normalizeForComparison", () => {
  it("returns a stable canonical form", () => {
    expect(normalizeForComparison("http://WWW.X.com/a/?utm_source=n")).toBe("https://x.com/a");
  });

  it("returns the input unchanged when it isn't a URL", () => {
    expect(normalizeForComparison("nonsense")).toBe("nonsense");
  });

  it("is idempotent", () => {
    const once = normalizeForComparison("http://www.x.com/a/");
    expect(normalizeForComparison(once)).toBe(once);
  });
});
