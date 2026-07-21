import { describe, it, expect } from "vitest";
import { classifyPlatformUrl, CLASSIFY_CONFIGS } from "./classify-platform-url";

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
