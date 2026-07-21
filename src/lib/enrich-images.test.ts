// The fake Supabase client below mimics supabase-js's fluent chain
// (.from().select().eq()…, plus .upsert()/.delete()), which isn't worth
// typing precisely for test plumbing — so `any` is allowed in this file.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OWNED_BY_DEDICATED_HARVESTER,
  enrichArtistImages,
  fetchOgImage,
  isPlaceholderImageUrl,
  PLATFORM_PRIORITY,
  SCRAPE_ONLY_PLATFORMS,
} from "./enrich-images";

const LASTFM_PLACEHOLDER =
  "https://lastfm.freetls.fastly.net/i/u/ar0/2a96cbd8b46e442fc41c2b86b821562f.jpg";

// ── Fake Supabase admin client ───────────────────────────────────────
// enrichArtistImages() makes these calls:
//   from("artists").select().eq("id").single()            -> the artist
//   from("artist_images").select().eq("artist_id")        -> stored images
//   from("harvest_failures").select().eq().eq().like()    -> no-image rows
//   from("artist_images").upsert(row, opts)               -> save an image
//   from("artist_images").delete().eq().eq()              -> drop stale image
//   from("harvest_failures").delete().eq("service")       -> clear failure
//   from("harvest_failures").upsert(row, opts)            -> record failure
// The builder is thenable so a read chain resolves when awaited; upsert
// and delete return their own promises and are recorded for assertions.

interface FakeState {
  artist: any;
  images?: any[];
  failures?: any[];
}

function makeClient(state: FakeState) {
  const calls = {
    upserts: [] as { table: string; row: any }[],
    deletes: [] as { table: string; eqs: Record<string, unknown> }[],
  };

  const client = {
    from(table: string) {
      const builder: any = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.like = () => builder;
      builder.single = () => Promise.resolve({ data: state.artist ?? null, error: null });
      builder.upsert = (row: any) => {
        calls.upserts.push({ table, row });
        return Promise.resolve({ error: null });
      };
      builder.delete = () => {
        const del: any = { eqs: {} as Record<string, unknown> };
        del.eq = (k: string, v: unknown) => {
          del.eqs[k] = v;
          return del;
        };
        del.then = (res: any, rej: any) => {
          calls.deletes.push({ table, eqs: del.eqs });
          return Promise.resolve({ error: null }).then(res, rej);
        };
        return del;
      };
      // Awaiting the builder itself resolves the read chains.
      builder.then = (res: any, rej: any) => {
        const data =
          table === "artist_images"
            ? state.images ?? []
            : table === "harvest_failures"
              ? state.failures ?? []
              : null;
        return Promise.resolve({ data, error: null }).then(res, rej);
      };
      return builder;
    },
  };

  return { client: client as any, calls };
}

// ── Fake fetch ───────────────────────────────────────────────────────
// fetchOgImage() falls back to res.text() when res.body is falsy, so a
// minimal { ok, status, body: null, text } stands in for a Response.

type FetchKind = "image" | "noimage" | "placeholder" | "error";

function ogHtml(imageUrl: string) {
  return `<html><head><meta property="og:image" content="${imageUrl}"></head></html>`;
}

function stubFetch(map: Record<string, FetchKind>) {
  const fetchMock = vi.fn(async (url: string) => {
    const kind = map[url] ?? "noimage";
    if (kind === "error") throw new Error("simulated network error");
    const html =
      kind === "image"
        ? ogHtml("https://cdn.example/pic.jpg")
        : kind === "placeholder"
          ? ogHtml(LASTFM_PLACEHOLDER)
          : `<html><head><title>no image here</title></head></html>`;
    return { ok: true, status: 200, body: null, text: async () => html };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function approvedArtist(
  links: { platform: string; url: string | null; not_found?: boolean }[]
) {
  return { id: "a1", name: "Test Artist", directory_status: "approved", links };
}

describe("enrichArtistImages — URL-change handling", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attempts a brand-new platform and stores the image with its source page URL", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/new" }]),
      images: [],
      failures: [],
    });
    stubFetch({ "https://spotify/new": "image" });

    const result = await enrichArtistImages("a1", client);

    expect(result.stored).toEqual(["spotify"]);
    const upsert = calls.upserts.find((u) => u.table === "artist_images");
    expect(upsert?.row.source_page_url).toBe("https://spotify/new");
  });

  it("skips a platform marked not-found entirely — never fetched, never recorded as a failure", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: null, not_found: true }]),
      images: [],
      failures: [],
    });
    const fetchMock = stubFetch({});

    const result = await enrichArtistImages("a1", client);

    // Treated exactly like a platform with no link row at all: not a
    // candidate, so no attempt, no fetch, and no harvest_failures write.
    expect(result.attempted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.upserts).toEqual([]);
  });

  it("still enriches other platforms alongside a not-found one", async () => {
    const { client } = makeClient({
      artist: approvedArtist([
        { platform: "spotify", url: null, not_found: true },
        { platform: "discogs", url: "https://discogs/real" },
      ]),
      images: [],
      failures: [],
    });
    const fetchMock = stubFetch({ "https://discogs/real": "image" });

    const result = await enrichArtistImages("a1", client);

    expect(result.stored).toEqual(["discogs"]);
    expect(result.attempted).toEqual(["discogs"]);
    expect(fetchMock).not.toHaveBeenCalledWith(null, expect.anything());
  });

  // "other" and "homepage" are catch-alls for arbitrary sites, so an
  // og:image scrape can't reliably yield a real profile photo. Neither
  // is image-capable; both must be ignored outright.
  it.each(["other", "homepage"])("never tries a %s link", async (platform) => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform, url: "https://some-random-site/artist" }]),
      images: [],
      failures: [],
    });
    const fetchMock = stubFetch({ "https://some-random-site/artist": "image" });

    const result = await enrichArtistImages("a1", client);

    expect(result.attempted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.upserts).toEqual([]);
  });

  it("excludes both catch-all platforms from PLATFORM_PRIORITY", () => {
    expect(PLATFORM_PRIORITY).not.toContain("other");
    expect(PLATFORM_PRIORITY).not.toContain("homepage");
  });

  it("skips a platform whose stored image came from the same (unchanged) link", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/same" }]),
      images: [{ platform: "spotify", source_page_url: "https://spotify/same" }],
      failures: [],
    });
    const fetchMock = stubFetch({});

    const result = await enrichArtistImages("a1", client);

    expect(result.skippedExisting).toEqual(["spotify"]);
    expect(result.attempted).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.upserts).toEqual([]);
  });

  it("re-fetches when the link changed and updates the stored image + source page URL", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/NEW" }]),
      images: [{ platform: "spotify", source_page_url: "https://spotify/OLD" }],
      failures: [],
    });
    const fetchMock = stubFetch({ "https://spotify/NEW": "image" });

    const result = await enrichArtistImages("a1", client);

    expect(fetchMock).toHaveBeenCalledWith("https://spotify/NEW", expect.anything());
    expect(result.stored).toEqual(["spotify"]);
    const upsert = calls.upserts.find((u) => u.table === "artist_images");
    expect(upsert?.row.source_page_url).toBe("https://spotify/NEW");
  });

  it("deletes the stale image when the link changed to a page with no image", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/NEW" }]),
      images: [{ platform: "spotify", source_page_url: "https://spotify/OLD" }],
      failures: [],
    });
    stubFetch({ "https://spotify/NEW": "noimage" });

    const result = await enrichArtistImages("a1", client);

    expect(result.removed).toEqual(["spotify"]);
    expect(result.stored).toEqual([]);
    // Stale artist_images row dropped, and the no-image result recorded
    // against the new URL so it isn't re-fetched next run.
    expect(calls.deletes.some((d) => d.table === "artist_images")).toBe(true);
    const failUpsert = calls.upserts.find((u) => u.table === "harvest_failures");
    expect(failUpsert?.row.url).toBe("https://spotify/NEW");
  });

  it("does NOT re-fetch or delete on a --force re-check of an unchanged link whose page lost its image", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/same" }]),
      images: [{ platform: "spotify", source_page_url: "https://spotify/same" }],
      failures: [],
    });
    stubFetch({ "https://spotify/same": "noimage" });

    const result = await enrichArtistImages("a1", client, { force: true });

    // Forced, so it re-fetches; page has no image now, but the link is
    // unchanged, so the existing image is left in place (not deleted).
    expect(result.attempted).toEqual(["spotify"]);
    expect(result.removed).toEqual([]);
    expect(calls.deletes.some((d) => d.table === "artist_images")).toBe(false);
  });

  it("treats a legacy image row (null source_page_url) as still covering the current link", async () => {
    const { client } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/whatever" }]),
      images: [{ platform: "spotify", source_page_url: null }],
      failures: [],
    });
    const fetchMock = stubFetch({});

    const result = await enrichArtistImages("a1", client);

    expect(result.skippedExisting).toEqual(["spotify"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-fetches a legacy image row when forced", async () => {
    const { client } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/whatever" }]),
      images: [{ platform: "spotify", source_page_url: null }],
      failures: [],
    });
    const fetchMock = stubFetch({ "https://spotify/whatever": "image" });

    const result = await enrichArtistImages("a1", client, { force: true });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.stored).toEqual(["spotify"]);
  });

  it("skips a confirmed no-image failure recorded against the same link", async () => {
    const { client } = makeClient({
      artist: approvedArtist([{ platform: "discogs", url: "https://discogs/same" }]),
      images: [],
      failures: [{ service: "image:discogs", status: "no_image", url: "https://discogs/same" }],
    });
    const fetchMock = stubFetch({});

    const result = await enrichArtistImages("a1", client);

    expect(result.skippedExisting).toEqual(["discogs"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a no-image failure when its link changed, and clears the failure on success", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "discogs", url: "https://discogs/NEW" }]),
      images: [],
      failures: [{ service: "image:discogs", status: "no_image", url: "https://discogs/OLD" }],
    });
    stubFetch({ "https://discogs/NEW": "image" });

    const result = await enrichArtistImages("a1", client);

    expect(result.stored).toEqual(["discogs"]);
    expect(calls.deletes.some((d) => d.table === "harvest_failures")).toBe(true);
  });

  it("never touches a dedicated-harvester platform, even when its link changed", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "soundcloud", url: "https://soundcloud/NEW" }]),
      images: [{ platform: "soundcloud", source_page_url: "https://soundcloud/OLD" }],
      failures: [],
    });
    const fetchMock = stubFetch({ "https://soundcloud/NEW": "image" });

    const result = await enrichArtistImages("a1", client);

    expect(result.skippedProtected).toEqual(["soundcloud"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.upserts).toEqual([]);
    expect(calls.deletes).toEqual([]);
  });

  // The ownership rule: a dedicated harvester owns its platform, and a
  // scrape is a fallback for exactly one case — the owner ran and failed
  // in a way that might not recur.

  it("leaves a dedicated-harvester platform alone when its owner has not run yet", async () => {
    const { client } = makeClient({
      artist: approvedArtist([{ platform: "soundcloud", url: "https://soundcloud/a" }]),
      images: [],
      failures: [],
    });
    const fetchMock = stubFetch({ "https://soundcloud/a": "image" });

    const result = await enrichArtistImages("a1", client);

    // No image and no failure row means sync-soundcloud simply hasn't got
    // here — not our platform to fetch.
    expect(result.skippedProtected).toEqual(["soundcloud"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scrapes a dedicated-harvester platform after its owner failed transiently", async () => {
    const { client } = makeClient({
      artist: approvedArtist([{ platform: "soundcloud", url: "https://soundcloud/a" }]),
      images: [],
      failures: [{ service: "image:soundcloud", status: "fetch_failed", url: "https://soundcloud/a" }],
    });
    const fetchMock = stubFetch({ "https://soundcloud/a": "image" });

    const result = await enrichArtistImages("a1", client);

    expect(result.stored).toEqual(["soundcloud"]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("does not scrape a dedicated-harvester platform its owner ruled out definitively", async () => {
    const { client } = makeClient({
      artist: approvedArtist([{ platform: "soundcloud", url: "https://soundcloud/a" }]),
      images: [],
      failures: [{ service: "image:soundcloud", status: "no_image", url: "https://soundcloud/a" }],
    });
    const fetchMock = stubFetch({ "https://soundcloud/a": "image" });

    const result = await enrichArtistImages("a1", client);

    // The owner already established there is no photo; re-deriving it via
    // a scrape would just re-confirm the same answer.
    expect(result.skippedExisting).toEqual(["soundcloud"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a Last.fm default placeholder as a no-image result rather than storing it", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "lastfm", url: "https://lastfm/artist" }]),
      images: [],
      failures: [],
    });
    stubFetch({ "https://lastfm/artist": "placeholder" });

    const result = await enrichArtistImages("a1", client);

    expect(result.stored).toEqual([]);
    expect(result.failed).toEqual(["lastfm"]);
    // No image stored; the no-image result is recorded in harvest_failures.
    expect(calls.upserts.some((u) => u.table === "artist_images")).toBe(false);
    const failUpsert = calls.upserts.find((u) => u.table === "harvest_failures");
    expect(failUpsert?.row.status).toBe("placeholder");
  });

  it("reports a removal in dry-run without writing to the DB", async () => {
    const { client, calls } = makeClient({
      artist: approvedArtist([{ platform: "spotify", url: "https://spotify/NEW" }]),
      images: [{ platform: "spotify", source_page_url: "https://spotify/OLD" }],
      failures: [],
    });
    stubFetch({ "https://spotify/NEW": "noimage" });

    const result = await enrichArtistImages("a1", client, { dryRun: true });

    expect(result.removed).toEqual(["spotify"]);
    expect(calls.deletes).toEqual([]);
    expect(calls.upserts).toEqual([]);
  });
});

describe("isPlaceholderImageUrl", () => {
  it("matches the Last.fm default star avatar at any size variant", () => {
    expect(isPlaceholderImageUrl(LASTFM_PLACEHOLDER)).toBe(true);
    expect(
      isPlaceholderImageUrl(
        "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png"
      )
    ).toBe(true);
  });

  it("does not match a real image URL", () => {
    expect(isPlaceholderImageUrl("https://cdn.example/real-photo.jpg")).toBe(false);
    expect(
      isPlaceholderImageUrl("https://lastfm.freetls.fastly.net/i/u/ar0/abc123realhash.jpg")
    ).toBe(false);
  });
});

describe("SCRAPE_ONLY_PLATFORMS", () => {
  it("excludes the platforms owned by a dedicated harvester", () => {
    expect(SCRAPE_ONLY_PLATFORMS).not.toContain("soundcloud");
    expect(SCRAPE_ONLY_PLATFORMS).not.toContain("bandcamp");
  });

  it("covers every other image-capable platform", () => {
    // The complement must stay exhaustive: anything dropped from here
    // silently loses its only source of images.
    const expected = PLATFORM_PRIORITY.filter((p) => !OWNED_BY_DEDICATED_HARVESTER.has(p));
    expect([...SCRAPE_ONLY_PLATFORMS].sort()).toEqual([...expected].sort());
    expect(SCRAPE_ONLY_PLATFORMS).toContain("spotify");
    expect(SCRAPE_ONLY_PLATFORMS).toContain("youtube");
  });
});

// ── fetchOgImage: meta tag discovery ─────────────────────────────────
// These drive the streaming path (res.body.getReader()), unlike the
// enrichArtistImages tests above which use the body:null text() fallback.

// Serves `html` as a byte stream in fixed-size chunks, so tests can put a
// chunk boundary in the middle of a meta tag.
function stubStreamingFetch(html: string, chunkSize: number) {
  const bytes = new TextEncoder().encode(html);
  const reader = () => {
    let offset = 0;
    return {
      async read() {
        if (offset >= bytes.length) return { done: true, value: undefined };
        const value = bytes.slice(offset, offset + chunkSize);
        offset += chunkSize;
        return { done: false, value };
      },
      async cancel() {},
    };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { getReader: reader },
      text: async () => html,
    }))
  );
}

describe("fetchOgImage — meta tag discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("finds og:image emitted inside <body>, past </head>", async () => {
    // YouTube's shape: the social meta tags sit well after the closing
    // head tag, so a head-only read misses them entirely.
    const html =
      `<html><head><title>Chan</title></head><body>` +
      "x".repeat(50_000) +
      `<meta property="og:image" content="https://cdn.example/avatar.jpg">` +
      `</body></html>`;
    stubStreamingFetch(html, 16_000);

    expect(await fetchOgImage("https://site.example/chan")).toEqual({
      found: true,
      imageUrl: "https://cdn.example/avatar.jpg",
    });
  });

  it("finds a meta tag straddling a chunk boundary", async () => {
    // Padding exceeds the rescan window, and 4990 puts the boundary at
    // 5000 ten characters into the tag.
    const html = "<html><body>" + "y".repeat(4978) + `<meta property="og:image" content="https://cdn.example/split.jpg"></body></html>`;
    expect(html.indexOf("<meta")).toBe(4990);
    stubStreamingFetch(html, 2_500);

    expect(await fetchOgImage("https://site.example/x")).toEqual({
      found: true,
      imageUrl: "https://cdn.example/split.jpg",
    });
  });

  it("prefers og:image even when twitter:image appears earlier", async () => {
    const html =
      `<html><head>` +
      `<meta name="twitter:image" content="https://cdn.example/twitter.jpg">` +
      `<meta property="og:image" content="https://cdn.example/og.jpg">` +
      `</head></html>`;
    stubStreamingFetch(html, 16_000);

    expect(await fetchOgImage("https://site.example/x")).toEqual({
      found: true,
      imageUrl: "https://cdn.example/og.jpg",
    });
  });

  it("falls back to twitter:image when the page has no og:image", async () => {
    const html = `<html><head><meta name="twitter:image" content="https://cdn.example/tw.jpg"></head></html>`;
    stubStreamingFetch(html, 16_000);

    expect(await fetchOgImage("https://site.example/x")).toEqual({
      found: true,
      imageUrl: "https://cdn.example/tw.jpg",
    });
  });

  it("reports an empty og:image separately from a missing tag", async () => {
    // SoundCloud's shape for an artist with no avatar — the platform is
    // affirmatively saying "no photo", which must not look like a
    // scrape failure in the logs.
    const html = `<html><head><meta property="og:image" content=""></head></html>`;
    stubStreamingFetch(html, 16_000);

    expect(await fetchOgImage("https://site.example/x")).toEqual({
      found: false,
      status: "no_image",
      detail: "og:image tag present but empty (no photo set)",
    });
  });

  it("reports a genuinely absent tag as a missing tag", async () => {
    const html = `<html><head><title>nothing here</title></head></html>`;
    stubStreamingFetch(html, 16_000);

    expect(await fetchOgImage("https://site.example/x")).toEqual({
      found: false,
      status: "no_image_tag",
      detail: "no og:image/twitter:image meta tag",
    });
  });

  it("resolves a relative image URL against the page URL", async () => {
    const html = `<html><head><meta property="og:image" content="/img/a.jpg"></head></html>`;
    stubStreamingFetch(html, 16_000);

    expect(await fetchOgImage("https://site.example/artist/x")).toEqual({
      found: true,
      imageUrl: "https://site.example/img/a.jpg",
    });
  });
});
