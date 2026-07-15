// The fake Supabase client below mimics supabase-js's fluent chain
// (.from().select().eq()…, plus .upsert()/.delete()), which isn't worth
// typing precisely for test plumbing — so `any` is allowed in this file.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enrichArtistImages, isPlaceholderImageUrl } from "./enrich-images";

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

function approvedArtist(links: { platform: string; url: string }[]) {
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
      failures: [{ service: "image-enrich:discogs", url: "https://discogs/same" }],
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
      failures: [{ service: "image-enrich:discogs", url: "https://discogs/OLD" }],
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
    expect(failUpsert?.row.status).toBe("no_og_image");
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
