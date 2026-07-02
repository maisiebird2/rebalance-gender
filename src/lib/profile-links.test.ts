import { describe, it, expect } from "vitest";
import { normalizeProfileLink, isTemplatedPlatform, resolveProfileLinkUrl } from "./profile-links";

describe("isTemplatedPlatform", () => {
  it("is true for platforms with a URL template", () => {
    expect(isTemplatedPlatform("instagram")).toBe(true);
    expect(isTemplatedPlatform("soundcloud")).toBe(true);
    expect(isTemplatedPlatform("bandcamp")).toBe(true);
    expect(isTemplatedPlatform("resident_advisor")).toBe(true);
  });

  it("is false for platforms that need more than a handle", () => {
    expect(isTemplatedPlatform("beatport")).toBe(false);
    expect(isTemplatedPlatform("qobuz")).toBe(false);
    expect(isTemplatedPlatform("discogs")).toBe(false);
    expect(isTemplatedPlatform("other")).toBe(false);
    expect(isTemplatedPlatform("some_new_admin_added_platform")).toBe(false);
  });
});

describe("normalizeProfileLink — bare handles", () => {
  it("builds a canonical Instagram URL from a bare handle", () => {
    const result = normalizeProfileLink("instagram", "techno_blondy");
    expect(result.url).toBe("https://www.instagram.com/techno_blondy/");
    expect(result.handle).toBe("techno_blondy");
    expect(result.wasTransformed).toBe(true);
    expect(result.warning).toBeNull();
  });

  it("strips a leading @ before building the URL", () => {
    const result = normalizeProfileLink("instagram", "@techno_blondy");
    expect(result.url).toBe("https://www.instagram.com/techno_blondy/");
  });

  it("builds a canonical SoundCloud URL from a bare handle", () => {
    const result = normalizeProfileLink("soundcloud", "some-dj-name");
    expect(result.url).toBe("https://soundcloud.com/some-dj-name");
  });

  it("builds a canonical Bandcamp URL and lowercases the subdomain", () => {
    const result = normalizeProfileLink("bandcamp", "SomeArtist");
    expect(result.url).toBe("https://someartist.bandcamp.com");
  });

  it("builds a canonical Resident Advisor URL using the singular /dj/ path", () => {
    const result = normalizeProfileLink("resident_advisor", "some-dj");
    expect(result.url).toBe("https://ra.co/dj/some-dj");
  });

  it("flags a handle that doesn't match the platform's usual format, but still builds a URL", () => {
    const result = normalizeProfileLink("instagram", "way..too..many..dots");
    expect(result.url).toBe("https://www.instagram.com/way..too..many..dots/");
    expect(result.warning).toMatch(/doesn't look like a typical handle/);
  });
});

describe("normalizeProfileLink — pasted URLs", () => {
  it("re-canonicalizes a full URL with tracking params", () => {
    const result = normalizeProfileLink("instagram", "https://instagram.com/techno_blondy/?hl=en");
    expect(result.url).toBe("https://www.instagram.com/techno_blondy/");
    expect(result.handle).toBe("techno_blondy");
  });

  it("accepts a URL without a scheme", () => {
    const result = normalizeProfileLink("instagram", "www.instagram.com/techno_blondy");
    expect(result.url).toBe("https://www.instagram.com/techno_blondy/");
  });

  it("extracts the Bandcamp handle from the subdomain, ignoring the path", () => {
    const result = normalizeProfileLink("bandcamp", "https://someartist.bandcamp.com/album/some-album");
    expect(result.url).toBe("https://someartist.bandcamp.com");
    expect(result.handle).toBe("someartist");
  });

  it("extracts the RA handle from a legacy plural /djs/ URL", () => {
    const result = normalizeProfileLink("resident_advisor", "https://ra.co/djs/some-dj");
    expect(result.url).toBe("https://ra.co/dj/some-dj");
  });

  it("leaves a URL for the correct platform untouched if it's already canonical", () => {
    const result = normalizeProfileLink("soundcloud", "https://soundcloud.com/some-dj-name");
    expect(result.url).toBe("https://soundcloud.com/some-dj-name");
    expect(result.wasTransformed).toBe(false);
  });
});

describe("normalizeProfileLink — mismatches and edge cases", () => {
  it("warns when the URL is for a different platform than the field", () => {
    const result = normalizeProfileLink("instagram", "https://soundcloud.com/techno_blondy");
    expect(result.warning).toMatch(/different site/);
    expect(result.url).toBe("https://soundcloud.com/techno_blondy");
  });

  it("warns when it can't find a handle in an otherwise-matching URL", () => {
    const result = normalizeProfileLink("instagram", "https://www.instagram.com/");
    expect(result.warning).toMatch(/Couldn't find a handle/);
  });

  it("passes non-templated platforms through unchanged", () => {
    const result = normalizeProfileLink("beatport", "some-slug");
    expect(result.url).toBe("some-slug");
    expect(result.wasTransformed).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("returns empty untouched for empty input", () => {
    const result = normalizeProfileLink("instagram", "   ");
    expect(result.url).toBe("");
    expect(result.wasTransformed).toBe(false);
  });
});

describe("resolveProfileLinkUrl", () => {
  it("uses the template for templated platforms, ignoring the fallback cleaner", () => {
    const fallback = (_platform: string, url: string) => `FALLBACK:${url}`;
    const url = resolveProfileLinkUrl("instagram", "techno_blondy", fallback);
    expect(url).toBe("https://www.instagram.com/techno_blondy/");
  });

  it("uses the fallback cleaner for non-templated platforms", () => {
    const fallback = (_platform: string, url: string) => `FALLBACK:${url}`;
    const url = resolveProfileLinkUrl("beatport", "some-slug", fallback);
    expect(url).toBe("FALLBACK:some-slug");
  });
});
