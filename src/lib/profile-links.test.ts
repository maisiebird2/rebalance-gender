import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeProfileLink,
  isTemplatedPlatform,
  resolveProfileLinkUrl,
  isSoundcloudShareLink,
  resolveShareUrl,
  resolveProfileLinkUrlAsync,
  deriveHandle,
  unwrapRedirectUrl,
  canonicalizeResidentAdvisorUrl,
} from "./profile-links";
import { cleanLinkUrl } from "./platforms";

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
    expect(result.url).toBe("https://www.instagram.com/techno_blondy");
    expect(result.handle).toBe("techno_blondy");
    expect(result.wasTransformed).toBe(true);
    expect(result.warning).toBeNull();
  });

  it("strips a leading @ before building the URL", () => {
    const result = normalizeProfileLink("instagram", "@techno_blondy");
    expect(result.url).toBe("https://www.instagram.com/techno_blondy");
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
    expect(result.url).toBe("https://www.instagram.com/way..too..many..dots");
    expect(result.warning).toMatch(/doesn't look like a typical handle/);
  });
});

describe("deriveHandle — bandcamp", () => {
  it("derives the handle from a bare Bandcamp subdomain", () => {
    expect(deriveHandle("bandcamp", "https://someartist.bandcamp.com")).toBe("someartist");
  });

  it("ignores a leading www. when deriving the Bandcamp handle", () => {
    expect(deriveHandle("bandcamp", "https://www.nulleinsrec.bandcamp.com/")).toBe("nulleinsrec");
  });
});

describe("normalizeProfileLink — pasted URLs", () => {
  it("re-canonicalizes a full URL with tracking params", () => {
    const result = normalizeProfileLink("instagram", "https://instagram.com/techno_blondy/?hl=en");
    expect(result.url).toBe("https://www.instagram.com/techno_blondy");
    expect(result.handle).toBe("techno_blondy");
  });

  it("accepts a URL without a scheme", () => {
    const result = normalizeProfileLink("instagram", "www.instagram.com/techno_blondy");
    expect(result.url).toBe("https://www.instagram.com/techno_blondy");
  });

  it("extracts the Bandcamp handle from the subdomain, ignoring the path", () => {
    const result = normalizeProfileLink("bandcamp", "https://someartist.bandcamp.com/album/some-album");
    expect(result.url).toBe("https://someartist.bandcamp.com");
    expect(result.handle).toBe("someartist");
  });

  it("strips a leading www. from a Bandcamp URL (www is never a real handle)", () => {
    const result = normalizeProfileLink("bandcamp", "https://www.nulleinsrec.bandcamp.com/");
    expect(result.url).toBe("https://nulleinsrec.bandcamp.com");
    expect(result.handle).toBe("nulleinsrec");
  });

  it("strips www. from a Bandcamp URL with a deep path too", () => {
    const result = normalizeProfileLink("bandcamp", "https://www.someartist.bandcamp.com/album/x");
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

describe("normalizeProfileLink — search URLs (no profile page)", () => {
  it("keeps a SoundCloud search URL, dropping tracking params", () => {
    const result = normalizeProfileLink(
      "soundcloud",
      "https://soundcloud.com/search?q=nancy%20whang&ref=share"
    );
    expect(result.url).toBe("https://soundcloud.com/search?q=nancy+whang");
    expect(result.handle).toBeNull();
    expect(result.warning).toBeNull();
  });

  it("keeps a Bandcamp apex search URL (not flagged as a different site)", () => {
    const result = normalizeProfileLink("bandcamp", "https://bandcamp.com/search?q=nancy%2Bwhang");
    expect(result.url).toBe("https://bandcamp.com/search?q=nancy%2Bwhang");
    expect(result.warning).toBeNull();
  });
});

describe("normalizeProfileLink — Resident Advisor", () => {
  it("does not warn on a handle that ends in a period", () => {
    const result = normalizeProfileLink("resident_advisor", "https://ra.co/dj/kali.");
    expect(result.url).toBe("https://ra.co/dj/kali.");
    expect(result.warning).toBeNull();
  });

  it("does not warn on a handle with interior periods", () => {
    const result = normalizeProfileLink("resident_advisor", "https://ra.co/dj/j.aria");
    expect(result.warning).toBeNull();
  });

  it("rewrites a pre-rebrand residentadvisor.net URL onto ra.co", () => {
    const result = normalizeProfileLink(
      "resident_advisor",
      "https://www.residentadvisor.net/dj/dianamay"
    );
    expect(result.url).toBe("https://ra.co/dj/dianamay");
    expect(result.warning).toBeNull();
  });
});

describe("canonicalizeResidentAdvisorUrl", () => {
  it("swaps the residentadvisor.net host for ra.co, keeping the path", () => {
    expect(canonicalizeResidentAdvisorUrl("https://www.residentadvisor.net/dj/dianamay")).toBe(
      "https://ra.co/dj/dianamay"
    );
    expect(canonicalizeResidentAdvisorUrl("http://residentadvisor.net/dj/adiel")).toBe(
      "https://ra.co/dj/adiel"
    );
  });

  it("leaves an already-ra.co or unrelated URL unchanged", () => {
    expect(canonicalizeResidentAdvisorUrl("https://ra.co/dj/dianamay")).toBe("https://ra.co/dj/dianamay");
    expect(canonicalizeResidentAdvisorUrl("https://soundcloud.com/x")).toBe("https://soundcloud.com/x");
    expect(canonicalizeResidentAdvisorUrl("not a url")).toBe("not a url");
  });
});

describe("deriveHandle — resident_advisor", () => {
  it("derives the handle from a singular /dj/ URL", () => {
    expect(deriveHandle("resident_advisor", "https://ra.co/dj/dianamay")).toBe("dianamay");
  });
});

describe("host matching does not false-positive on lookalike domains", () => {
  it("treats notbandcamp.com as a different site, not a bandcamp handle", () => {
    const result = normalizeProfileLink("bandcamp", "https://notbandcamp.com/foo");
    expect(result.warning).toMatch(/different site/);
  });
});

describe("resolveProfileLinkUrl", () => {
  it("uses the template for templated platforms, ignoring the fallback cleaner", () => {
    const fallback = (_platform: string, url: string) => `FALLBACK:${url}`;
    const url = resolveProfileLinkUrl("instagram", "techno_blondy", fallback);
    expect(url).toBe("https://www.instagram.com/techno_blondy");
  });

  it("uses the fallback cleaner for non-templated platforms", () => {
    const fallback = (_platform: string, url: string) => `FALLBACK:${url}`;
    const url = resolveProfileLinkUrl("beatport", "some-slug", fallback);
    expect(url).toBe("FALLBACK:some-slug");
  });

  it("strips a trailing slash so stored URLs are consistent across platforms", () => {
    // Templated platform: buildUrl output already slash-free.
    expect(resolveProfileLinkUrl("bandcamp", "https://x.bandcamp.com/album/y", (_p, u) => u)).toBe(
      "https://x.bandcamp.com"
    );
    // Non-templated platform: a fallback that yields a trailing slash
    // still ends up slash-free.
    const passthrough = (_p: string, u: string) => u;
    expect(resolveProfileLinkUrl("discogs", "https://www.discogs.com/artist/123-Name/", passthrough)).toBe(
      "https://www.discogs.com/artist/123-Name"
    );
  });
});

describe("unwrapRedirectUrl", () => {
  const WRAPPED =
    "https://l.instagram.com/?u=https%3A%2F%2Flinktr.ee%2Fmartha_radio%3Futm_source%3Dig%26utm_medium%3Dsocial%26utm_content%3Dlink_in_bio%26fbclid%3DPAZabc&e=AUAu077sm9VUpqxy9uhJRvb";

  it("expands an l.instagram.com link shim to its decoded destination", () => {
    expect(unwrapRedirectUrl(WRAPPED)).toBe(
      "https://linktr.ee/martha_radio?utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZabc"
    );
  });

  it("leaves a normal (non-shim) URL untouched", () => {
    expect(unwrapRedirectUrl("https://linktr.ee/martha_radio")).toBe("https://linktr.ee/martha_radio");
  });

  it("returns the input unchanged when the shim has no destination param", () => {
    expect(unwrapRedirectUrl("https://l.instagram.com/")).toBe("https://l.instagram.com/");
  });

  it("unwraps a doubly-wrapped link", () => {
    const inner = encodeURIComponent("https://linktr.ee/foo");
    const middle = encodeURIComponent(`https://l.facebook.com/?u=${inner}`);
    expect(unwrapRedirectUrl(`https://l.instagram.com/?u=${middle}`)).toBe("https://linktr.ee/foo");
  });
});

describe("link-shim unwrapping through the save path", () => {
  const WRAPPED =
    "https://l.instagram.com/?u=https%3A%2F%2Flinktr.ee%2Fmartha_radio%3Futm_source%3Dig%26fbclid%3DPAZabc&e=AUAu077";

  it("resolves a wrapped Linktree URL to the bare profile (tracking stripped)", () => {
    expect(resolveProfileLinkUrl("linktree", WRAPPED, cleanLinkUrl)).toBe(
      "https://linktr.ee/martha_radio"
    );
  });

  it("unwraps to a templated platform's canonical URL when wrapped", () => {
    const wrappedSc =
      "https://l.instagram.com/?u=https%3A%2F%2Fsoundcloud.com%2Freal-artist%3Fsi%3Dabc&e=x";
    const result = normalizeProfileLink("soundcloud", wrappedSc);
    expect(result.url).toBe("https://soundcloud.com/real-artist");
    expect(result.wasTransformed).toBe(true);
  });
});

describe("isSoundcloudShareLink", () => {
  it("recognizes on.soundcloud.com share links, with or without a scheme", () => {
    expect(isSoundcloudShareLink("https://on.soundcloud.com/8KP9u6WaRSeo1ycHww")).toBe(true);
    expect(isSoundcloudShareLink("on.soundcloud.com/8KP9u6WaRSeo1ycHww")).toBe(true);
  });

  it("does not treat a normal soundcloud.com profile as a share link", () => {
    expect(isSoundcloudShareLink("https://soundcloud.com/some-dj-name")).toBe(false);
  });
});

describe("normalizeProfileLink — SoundCloud share links (sync guard)", () => {
  it("leaves an unresolved on.soundcloud.com link completely untouched", () => {
    const share = "https://on.soundcloud.com/8KP9u6WaRSeo1ycHww";
    const result = normalizeProfileLink("soundcloud", share);
    // Must NOT extract the opaque ID into https://soundcloud.com/<id>.
    expect(result.url).toBe(share);
    expect(result.wasTransformed).toBe(false);
    expect(result.warning).toBeNull();
  });
});

describe("resolveShareUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns non-share input unchanged without any network call", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const out = await resolveShareUrl("https://soundcloud.com/some-dj-name");
    expect(out).toBe("https://soundcloud.com/some-dj-name");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("expands a share link to the redirect's canonical URL, dropping query params", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      url: "https://soundcloud.com/real-artist?ref=share",
    } as unknown as Response);
    const out = await resolveShareUrl("https://on.soundcloud.com/8KP9u6WaRSeo1ycHww");
    expect(out).toBe("https://soundcloud.com/real-artist");
  });

  it("returns the original share link if the fetch throws", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    const share = "https://on.soundcloud.com/8KP9u6WaRSeo1ycHww";
    expect(await resolveShareUrl(share)).toBe(share);
  });

  it("returns the original share link if the redirect lands off soundcloud.com", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      url: "https://login.example.com/blocked",
    } as unknown as Response);
    const share = "https://on.soundcloud.com/8KP9u6WaRSeo1ycHww";
    expect(await resolveShareUrl(share)).toBe(share);
  });
});

describe("resolveProfileLinkUrlAsync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands then canonicalizes a SoundCloud share link", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      url: "https://soundcloud.com/real-artist?si=abc",
    } as unknown as Response);
    const url = await resolveProfileLinkUrlAsync(
      "soundcloud",
      "https://on.soundcloud.com/8KP9u6WaRSeo1ycHww",
      (_p, u) => u
    );
    // resolveShareUrl → https://soundcloud.com/real-artist (query dropped)
    // normalizeProfileLink → canonical profile URL.
    expect(url).toBe("https://soundcloud.com/real-artist");
  });

  it("stores the original share link when resolution fails", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("timeout"));
    const share = "https://on.soundcloud.com/8KP9u6WaRSeo1ycHww";
    const url = await resolveProfileLinkUrlAsync("soundcloud", share, (_p, u) => u);
    expect(url).toBe(share);
  });

  it("does not fetch for non-soundcloud platforms", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const url = await resolveProfileLinkUrlAsync("instagram", "techno_blondy", (_p, u) => u);
    expect(url).toBe("https://www.instagram.com/techno_blondy");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
