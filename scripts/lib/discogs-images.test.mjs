import { describe, it, expect } from "vitest";
import { pickDiscogsImageUrl, writeDiscogsImage, DISCOGS_IMAGE_SERVICE } from "./discogs-images.mjs";

describe("pickDiscogsImageUrl", () => {
  it("prefers the primary image over secondary ones", () => {
    const images = [
      { type: "secondary", uri: "https://i.discogs.com/second.jpg" },
      { type: "primary", uri: "https://i.discogs.com/main.jpg" },
    ];
    expect(pickDiscogsImageUrl(images)).toBe("https://i.discogs.com/main.jpg");
  });

  it("falls back to the first image when none is marked primary", () => {
    const images = [
      { type: "secondary", uri: "https://i.discogs.com/a.jpg" },
      { type: "secondary", uri: "https://i.discogs.com/b.jpg" },
    ];
    expect(pickDiscogsImageUrl(images)).toBe("https://i.discogs.com/a.jpg");
  });

  it("uses the full-size uri, not the uri150 thumbnail", () => {
    const images = [{ type: "primary", uri: "https://i.discogs.com/full.jpg", uri150: "https://i.discogs.com/thumb.jpg" }];
    expect(pickDiscogsImageUrl(images)).toBe("https://i.discogs.com/full.jpg");
  });

  it("returns null for an empty, missing, or non-array images field", () => {
    expect(pickDiscogsImageUrl([])).toBeNull();
    expect(pickDiscogsImageUrl(undefined)).toBeNull();
    expect(pickDiscogsImageUrl(null)).toBeNull();
    expect(pickDiscogsImageUrl("nope")).toBeNull();
  });

  it("returns null when the chosen entry has no usable uri", () => {
    expect(pickDiscogsImageUrl([{ type: "primary", uri: "" }])).toBeNull();
    expect(pickDiscogsImageUrl([{ type: "primary" }])).toBeNull();
  });
});

// A minimal fake capturing the two tables writeDiscogsImage touches:
// artist_images (upsert) and harvest_failures (upsert via recordFailure /
// delete via clearFailure).
function makeClient({ upsertError = null } = {}) {
  const calls = { upserts: [], deletes: [] };
  const client = {
    from(table) {
      return {
        upsert(row) {
          calls.upserts.push({ table, row });
          return Promise.resolve({ error: table === "artist_images" ? upsertError : null });
        },
        delete() {
          const del = { eqs: {} };
          del.eq = (k, v) => {
            del.eqs[k] = v;
            return del;
          };
          del.then = (res, rej) => {
            calls.deletes.push({ table, eqs: del.eqs });
            return Promise.resolve({ error: null }).then(res, rej);
          };
          return del;
        },
      };
    },
  };
  return { client, calls };
}

describe("writeDiscogsImage", () => {
  const base = { artistId: "a1", discogsUrl: "https://www.discogs.com/artist/1", images: [{ type: "primary", uri: "https://i.discogs.com/main.jpg" }] };

  it("does nothing for a non-directory artist", async () => {
    const { client, calls } = makeClient();
    const status = await writeDiscogsImage({ supabase: client, ...base, isApproved: false });
    expect(status).toBe("not_approved");
    expect(calls.upserts).toEqual([]);
    expect(calls.deletes).toEqual([]);
  });

  it("stores the image and clears any prior failure on success", async () => {
    const { client, calls } = makeClient();
    const status = await writeDiscogsImage({ supabase: client, ...base, isApproved: true });
    expect(status).toBe("stored");
    const imageUpsert = calls.upserts.find((u) => u.table === "artist_images");
    expect(imageUpsert.row).toMatchObject({
      artist_id: "a1",
      platform: "discogs",
      source_url: "https://i.discogs.com/main.jpg",
      source_page_url: "https://www.discogs.com/artist/1",
    });
    // clearFailure deletes the image:discogs failure row.
    expect(calls.deletes.some((d) => d.table === "harvest_failures" && d.eqs.service === DISCOGS_IMAGE_SERVICE)).toBe(true);
  });

  it("records a no_image failure (keyed to the profile URL) when there is no image", async () => {
    const { client, calls } = makeClient();
    const status = await writeDiscogsImage({ supabase: client, ...base, images: [], isApproved: true });
    expect(status).toBe("no_image");
    expect(calls.upserts.some((u) => u.table === "artist_images")).toBe(false);
    const fail = calls.upserts.find((u) => u.table === "harvest_failures");
    expect(fail.row).toMatchObject({ service: DISCOGS_IMAGE_SERVICE, status: "no_image", url: base.discogsUrl });
  });

  it("records a write_failed failure when the upsert errors", async () => {
    const { client, calls } = makeClient({ upsertError: { message: "boom" } });
    const status = await writeDiscogsImage({ supabase: client, ...base, isApproved: true });
    expect(status).toBe("failed");
    const fail = calls.upserts.find((u) => u.table === "harvest_failures");
    expect(fail.row).toMatchObject({ service: DISCOGS_IMAGE_SERVICE, status: "write_failed" });
  });

  it("writes nothing in dry-run but still reports the would-be outcome", async () => {
    const { client, calls } = makeClient();
    const status = await writeDiscogsImage({ supabase: client, ...base, isApproved: true, dryRun: true });
    expect(status).toBe("stored");
    expect(calls.upserts).toEqual([]);
    expect(calls.deletes).toEqual([]);
  });
});
