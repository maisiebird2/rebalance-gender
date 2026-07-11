import { describe, it, expect } from "vitest";
import { normalizeUrl } from "./route";

describe("normalizeUrl", () => {
  it("treats http and https as equivalent", () => {
    expect(normalizeUrl("http://soundcloud.com/some-artist")).toBe(
      normalizeUrl("https://soundcloud.com/some-artist"),
    );
  });

  it("strips a leading www.", () => {
    expect(normalizeUrl("https://www.soundcloud.com/some-artist")).toBe(
      normalizeUrl("https://soundcloud.com/some-artist"),
    );
  });

  it("strips a trailing slash", () => {
    expect(normalizeUrl("https://soundcloud.com/some-artist/")).toBe(
      normalizeUrl("https://soundcloud.com/some-artist"),
    );
  });

  it("is case-insensitive on host and path", () => {
    expect(normalizeUrl("https://SoundCloud.com/Some-Artist")).toBe(
      normalizeUrl("https://soundcloud.com/some-artist"),
    );
  });

  it("drops query strings and fragments", () => {
    expect(normalizeUrl("https://soundcloud.com/some-artist?ref=share#top")).toBe(
      normalizeUrl("https://soundcloud.com/some-artist"),
    );
  });

  it("distinguishes different paths", () => {
    expect(normalizeUrl("https://soundcloud.com/artist-a")).not.toBe(
      normalizeUrl("https://soundcloud.com/artist-b"),
    );
  });

  it("falls back to a lowercase trim for unparseable input", () => {
    expect(normalizeUrl("Not A Url/")).toBe("not a url");
  });
});
