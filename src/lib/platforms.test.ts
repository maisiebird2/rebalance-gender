import { describe, it, expect } from "vitest";
import {
  platformDisplayLabel,
  platformLabel,
  PLATFORM_DISPLAY_ORDER,
  isPlatformShownOnPublicPage,
  visiblePublicLinks,
  sortPlatformsForForms,
} from "./platforms";
import type { Platform } from "./types";

function platform(key: string, label: string): Platform {
  return { key, label, sort_order: 0, search_url_template: null };
}

const PLATFORMS = [
  platform("soundcloud", "SoundCloud"),
  platform("resident_advisor", "Resident Advisor"),
];

describe("platformDisplayLabel", () => {
  it("shortens Resident Advisor to RA", () => {
    expect(platformDisplayLabel(platform("resident_advisor", "Resident Advisor"))).toBe("RA");
  });

  it("passes every other platform's stored label through", () => {
    expect(platformDisplayLabel(platform("soundcloud", "SoundCloud"))).toBe("SoundCloud");
  });
});

describe("platformLabel", () => {
  it("applies the display override when resolving by key", () => {
    expect(platformLabel(PLATFORMS, "resident_advisor")).toBe("RA");
    expect(platformLabel(PLATFORMS, "soundcloud")).toBe("SoundCloud");
  });

  it("falls back to the key for an unknown platform", () => {
    expect(platformLabel(PLATFORMS, "mixcloud")).toBe("mixcloud");
  });
});

describe("visiblePublicLinks", () => {
  function link(platform: string, over: { url?: string | null; not_found?: boolean } = {}) {
    return {
      platform,
      url: over.url === undefined ? `https://example.com/${platform}` : over.url,
      not_found: over.not_found ?? false,
    };
  }

  it("orders links by PLATFORM_DISPLAY_ORDER, not by input order", () => {
    const links = [
      link("other"),
      link("instagram"),
      link("homepage"),
      link("hoer"),
      link("soundcloud"),
    ];
    expect(visiblePublicLinks(links).map((l) => l.platform)).toEqual([
      "homepage",
      "soundcloud",
      "instagram",
      "hoer",
      "other",
    ]);
  });

  it("hides the platforms that are absent from the order", () => {
    const links = [link("spotify"), link("musicbrainz"), link("lastfm"), link("tidal")];
    expect(visiblePublicLinks(links).map((l) => l.platform)).toEqual(["tidal"]);
  });

  it("drops not-found and url-less rows", () => {
    const links = [
      link("soundcloud", { not_found: true }),
      link("instagram", { url: null }),
      link("bandcamp"),
    ];
    expect(visiblePublicLinks(links).map((l) => l.platform)).toEqual(["bandcamp"]);
  });

  it("treats null/undefined link lists as empty", () => {
    expect(visiblePublicLinks(null)).toEqual([]);
    expect(visiblePublicLinks(undefined)).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const links = [link("other"), link("homepage")];
    visiblePublicLinks(links);
    expect(links.map((l) => l.platform)).toEqual(["other", "homepage"]);
  });
});

describe("PLATFORM_DISPLAY_ORDER", () => {
  it("lists every platform exactly once", () => {
    expect(new Set(PLATFORM_DISPLAY_ORDER).size).toBe(
      PLATFORM_DISPLAY_ORDER.length
    );
  });

  it("agrees with isPlatformShownOnPublicPage", () => {
    expect(isPlatformShownOnPublicPage("homepage")).toBe(true);
    expect(isPlatformShownOnPublicPage("spotify")).toBe(false);
    expect(isPlatformShownOnPublicPage("mixcloud")).toBe(false);
  });
});

describe("sortPlatformsForForms", () => {
  it("puts the form fields in PLATFORM_DISPLAY_ORDER", () => {
    const input = [
      platform("other", "Other"),
      platform("instagram", "Instagram"),
      platform("homepage", "Homepage"),
      platform("soundcloud", "SoundCloud"),
    ];
    expect(sortPlatformsForForms(input).map((p) => p.key)).toEqual([
      "homepage",
      "soundcloud",
      "instagram",
      "other",
    ]);
  });

  it("keeps platforms outside the order editable, appended at the end", () => {
    const input = [
      platform("spotify", "Spotify"),
      platform("instagram", "Instagram"),
      platform("musicbrainz", "MusicBrainz"),
      platform("homepage", "Homepage"),
    ];
    expect(sortPlatformsForForms(input).map((p) => p.key)).toEqual([
      "homepage",
      "instagram",
      "spotify",
      "musicbrainz",
    ]);
  });

  it("leaves the unordered tail in the order getPlatforms supplied", () => {
    const input = [
      platform("lastfm", "Last.fm"),
      platform("spotify", "Spotify"),
      platform("musicbrainz", "MusicBrainz"),
    ];
    expect(sortPlatformsForForms(input).map((p) => p.key)).toEqual([
      "lastfm",
      "spotify",
      "musicbrainz",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const input = [platform("other", "Other"), platform("homepage", "Homepage")];
    sortPlatformsForForms(input);
    expect(input.map((p) => p.key)).toEqual(["other", "homepage"]);
  });
});
