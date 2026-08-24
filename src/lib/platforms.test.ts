import { describe, it, expect } from "vitest";
import {
  platformDisplayLabel,
  platformLabel,
  PUBLIC_PAGE_PLATFORM_ORDER,
  isPlatformShownOnPublicPage,
  visiblePublicLinks,
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

  it("orders links by PUBLIC_PAGE_PLATFORM_ORDER, not by input order", () => {
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

describe("PUBLIC_PAGE_PLATFORM_ORDER", () => {
  it("lists every platform exactly once", () => {
    expect(new Set(PUBLIC_PAGE_PLATFORM_ORDER).size).toBe(
      PUBLIC_PAGE_PLATFORM_ORDER.length
    );
  });

  it("agrees with isPlatformShownOnPublicPage", () => {
    expect(isPlatformShownOnPublicPage("homepage")).toBe(true);
    expect(isPlatformShownOnPublicPage("spotify")).toBe(false);
    expect(isPlatformShownOnPublicPage("mixcloud")).toBe(false);
  });
});
