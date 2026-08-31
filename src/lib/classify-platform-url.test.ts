import { describe, it, expect } from "vitest";
import {
  classifyPlatformUrl,
  CLASSIFY_CONFIGS,
  reclassifyResolvedUrl,
} from "./classify-platform-url";

describe("classifyPlatformUrl — shared table", () => {
  it("maps the core platforms", () => {
    const cases: Array<[string, string]> = [
      ["https://soundcloud.com/some-dj", "soundcloud"],
      ["https://www.instagram.com/techno_blondy", "instagram"],
      ["https://ra.co/dj/dianamay", "resident_advisor"],
      ["https://www.residentadvisor.net/dj/dianamay", "resident_advisor"],
      ["https://artist.bandcamp.com/album/x", "bandcamp"],
      ["https://www.beatport.com/artist/mara-trax/62418", "beatport"],
      ["https://www.discogs.com/artist/123-Name", "discogs"],
      ["https://linktr.ee/juli.tracks", "linktree"],
      ["https://www.tiktok.com/@i.am.blanka", "tiktok"],
      ["https://www.qobuz.com/us-en/interpreter/x/1", "qobuz"],
      ["https://songkick.com/artists/1", "songkick"],
      ["https://musicbrainz.org/artist/abc", "musicbrainz"],
      ["https://hoer.live/artist/someone", "hoer"],
      ["https://hoer.berlin/artist/someone", "hoer"],
      ["https://djanes.world-clubs.com/en/djanes/uncle-waffles", "djanes"],
      ["https://www.1001tracklists.com/dj/someone/", "1001tracklists"],
    ];
    for (const [url, platform] of cases) {
      expect(classifyPlatformUrl(url), url).toBe(platform);
    }
  });

  it("matches subdomains of a mapped domain", () => {
    expect(classifyPlatformUrl("https://open.spotify.com/artist/x")).toBe("spotify");
    expect(classifyPlatformUrl("https://music.youtube.com/channel/x")).toBe("youtube");
    expect(classifyPlatformUrl("https://m.youtube.com/watch?v=x")).toBe("youtube");
    expect(classifyPlatformUrl("https://listen.tidal.com/artist/1")).toBe("tidal");
    expect(classifyPlatformUrl("https://en.wikipedia.org/wiki/X")).toBe("wikipedia");
  });

  it("maps every alias host for a platform to the same key", () => {
    expect(classifyPlatformUrl("https://youtu.be/abc")).toBe("youtube");
    expect(classifyPlatformUrl("https://spotify.link/abc")).toBe("spotify");
    expect(classifyPlatformUrl("https://fb.me/abc")).toBe("facebook");
    expect(classifyPlatformUrl("https://fb.com/abc")).toBe("facebook");
    expect(classifyPlatformUrl("https://www.facebook.com/abc")).toBe("facebook");
    expect(classifyPlatformUrl("https://music.apple.com/us/artist/x")).toBe("apple_music");
    expect(classifyPlatformUrl("https://itunes.apple.com/us/artist/x")).toBe("apple_music");
    expect(classifyPlatformUrl("https://last.fm/music/X")).toBe("lastfm");
    expect(classifyPlatformUrl("https://www.lastfm.de/music/X")).toBe("lastfm");
  });

  it("matches DJanes on its subdomain without claiming the site it sits on", () => {
    // djanes.world-clubs.com is a section of a general clubs directory, so the
    // pattern has to stop at that subdomain: world-clubs.com at large is not
    // DJanes, and filing it there would mislabel every unrelated page on it.
    expect(classifyPlatformUrl("https://djanes.world-clubs.com/en/djanes/uncle-waffles")).toBe(
      "djanes"
    );
    expect(classifyPlatformUrl("https://www.djanes.world-clubs.com/en/djanes/x")).toBe("djanes");
    expect(classifyPlatformUrl("https://world-clubs.com/en/clubs/berghain")).toBe("other");
    expect(classifyPlatformUrl("https://clubs.world-clubs.com/en/x")).toBe("other");
  });

  it("does not false-positive on lookalike domains", () => {
    expect(classifyPlatformUrl("https://notbandcamp.com/foo")).toBe("other");
    expect(classifyPlatformUrl("https://myspotify.com.evil.net/x")).toBe("other");
  });

  it("falls back to 'other' for an unrecognized domain", () => {
    expect(classifyPlatformUrl("https://some-personal-site.de/about")).toBe("other");
  });

  it("skips Twitter/X and t.co by policy, for every caller", () => {
    expect(classifyPlatformUrl("https://twitter.com/x")).toBeNull();
    expect(classifyPlatformUrl("https://x.com/x")).toBeNull();
    expect(classifyPlatformUrl("https://t.co/abc")).toBeNull();
    expect(classifyPlatformUrl("https://t.co/abc", CLASSIFY_CONFIGS.linktree)).toBeNull();
  });

  it("skips unparseable URLs and non-http(s) schemes", () => {
    expect(classifyPlatformUrl("not a url")).toBeNull();
    expect(classifyPlatformUrl("mailto:me@example.com")).toBeNull();
    expect(classifyPlatformUrl("tel:+1234")).toBeNull();
  });
});

describe("classifyPlatformUrl — per-harvester configs", () => {
  it("each harvester skips links back to its own source platform", () => {
    expect(classifyPlatformUrl("https://musicbrainz.org/artist/a", CLASSIFY_CONFIGS.musicbrainz)).toBeNull();
    expect(classifyPlatformUrl("https://artist.bandcamp.com/x", CLASSIFY_CONFIGS.bandcamp)).toBeNull();
    expect(classifyPlatformUrl("https://soundcloud.com/x", CLASSIFY_CONFIGS.soundcloud)).toBeNull();
    expect(classifyPlatformUrl("https://www.discogs.com/artist/1", CLASSIFY_CONFIGS.discogs)).toBeNull();
    expect(classifyPlatformUrl("https://linktr.ee/x", CLASSIFY_CONFIGS.linktree)).toBeNull();
    expect(classifyPlatformUrl("https://soundcloud.com/x", CLASSIFY_CONFIGS.harvested_links)).toBeNull();
  });

  it("still classifies OTHER platforms normally under a harvester config", () => {
    expect(classifyPlatformUrl("https://soundcloud.com/x", CLASSIFY_CONFIGS.bandcamp)).toBe("soundcloud");
    expect(classifyPlatformUrl("https://artist.bandcamp.com/x", CLASSIFY_CONFIGS.soundcloud)).toBe("bandcamp");
  });

  it("HÖR skips YouTube — its set videos aren't an artist-channel signal", () => {
    expect(classifyPlatformUrl("https://www.youtube.com/watch?v=x", CLASSIFY_CONFIGS.hoer)).toBeNull();
    expect(classifyPlatformUrl("https://youtu.be/x", CLASSIFY_CONFIGS.hoer)).toBeNull();
    expect(classifyPlatformUrl("https://hoer.live/x", CLASSIFY_CONFIGS.hoer)).toBeNull();
    // …but YouTube is a normal mapped platform for everyone else.
    expect(classifyPlatformUrl("https://www.youtube.com/watch?v=x")).toBe("youtube");
  });

  it("MusicBrainz skips its own domain and wikidata, but keeps wikipedia", () => {
    expect(classifyPlatformUrl("https://wikidata.org/wiki/Q1", CLASSIFY_CONFIGS.musicbrainz)).toBeNull();
    expect(classifyPlatformUrl("https://en.wikipedia.org/wiki/X", CLASSIFY_CONFIGS.musicbrainz)).toBe(
      "wikipedia"
    );
  });

  it("Linktree stages unknown domains under the bare domain, never 'other'", () => {
    expect(classifyPlatformUrl("https://some-personal-site.de/x", CLASSIFY_CONFIGS.linktree)).toBe(
      "some-personal-site.de"
    );
    expect(classifyPlatformUrl("https://www.some-personal-site.de/x", CLASSIFY_CONFIGS.linktree)).toBe(
      "some-personal-site.de"
    );
  });

  it("Linktree overrides mixcloud to a retained-not-promoted key", () => {
    expect(classifyPlatformUrl("https://www.mixcloud.com/x", CLASSIFY_CONFIGS.linktree)).toBe("mixcloud");
    // Every other caller leaves mixcloud in the promotable "other".
    expect(classifyPlatformUrl("https://www.mixcloud.com/x")).toBe("other");
    expect(classifyPlatformUrl("https://www.mixcloud.com/x", CLASSIFY_CONFIGS.discogs)).toBe("other");
  });

  it("Linktree still resolves mapped platforms ahead of its bare-domain fallback", () => {
    expect(classifyPlatformUrl("https://www.instagram.com/x", CLASSIFY_CONFIGS.linktree)).toBe("instagram");
  });
});

describe("reclassifyResolvedUrl", () => {
  it("takes a positive identification over the row's existing key", () => {
    // The case this exists for: a soundcloud.app.goo.gl row sits under "other"
    // only because classification ran on the shortener host. Resolution is when
    // that becomes knowable.
    expect(reclassifyResolvedUrl("https://soundcloud.com/kling_und_klang", "other")).toEqual({
      kind: "platform",
      platform: "soundcloud",
    });
    expect(reclassifyResolvedUrl("https://www.youtube.com/channel/UC_dO", "other")).toEqual({
      kind: "platform",
      platform: "youtube",
    });
  });

  it("keeps the existing key when no rule matches, rather than downgrading to 'other'", () => {
    // homepage, djanes, 1001tracklists and hoer are real platform keys that
    // live outside DOMAIN_PLATFORM_MAP, as are sync-linktree's bare-domain
    // staging keys. "other" is a fallback, not a finding, so it must not win.
    for (const existing of ["homepage", "djanes", "1001tracklists", "hoer", "ffm.to"]) {
      expect(reclassifyResolvedUrl("https://some-personal-site.example.com/x", existing)).toEqual({
        kind: "platform",
        platform: existing,
      });
    }
  });

  it("leaves an already-'other' row as 'other'", () => {
    expect(reclassifyResolvedUrl("https://docs.google.com/forms/d/e/abc", "other")).toEqual({
      kind: "platform",
      platform: "other",
    });
  });

  it("refuses a destination the project excludes", () => {
    // Twitter/X is skip-listed by policy. A shortener resolving there must not
    // be laundered into a storable link.
    expect(reclassifyResolvedUrl("https://x.com/someone", "other")).toEqual({ kind: "refused" });
    expect(reclassifyResolvedUrl("https://twitter.com/someone", "other")).toEqual({ kind: "refused" });
    expect(reclassifyResolvedUrl("https://t.co/abc", "other")).toEqual({ kind: "refused" });
  });

  it("refuses an unparseable or non-http destination", () => {
    expect(reclassifyResolvedUrl("mailto:someone@example.com", "other")).toEqual({ kind: "refused" });
    expect(reclassifyResolvedUrl("not a url", "other")).toEqual({ kind: "refused" });
  });

  it("ignores the harvester self-link skips", () => {
    // The skip configs are about where a link was FOUND. After resolution the
    // question is where it goes, so a resolved soundcloud.com URL is a real
    // SoundCloud link — the old harvested_links config would have nulled this,
    // stranding all 523 staged on.soundcloud.com rows.
    expect(reclassifyResolvedUrl("https://soundcloud.com/real-artist", "soundcloud")).toEqual({
      kind: "platform",
      platform: "soundcloud",
    });
  });
});
