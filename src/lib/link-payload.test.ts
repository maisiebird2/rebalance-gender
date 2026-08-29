import { describe, it, expect } from "vitest";
import { parseLinkPayload, resolveLinkPayload, type LinkPayloadRow } from "./link-payload";

/** A payload row with the boilerplate filled in. */
function row(partial: Partial<LinkPayloadRow> & { url?: string | null }): LinkPayloadRow {
  return {
    platform: partial.platform ?? "",
    url: partial.url ?? null,
    not_found: partial.not_found ?? false,
    position: partial.position ?? 0,
  };
}

describe("parseLinkPayload — the array shape", () => {
  it("reads the list the forms now post", () => {
    expect(
      parseLinkPayload([
        { platform: "soundcloud", url: "https://soundcloud.com/a", not_found: false, position: 0 },
        { platform: "instagram", url: null, not_found: true, position: 1 },
      ])
    ).toEqual([
      { platform: "soundcloud", url: "https://soundcloud.com/a", not_found: false, position: 0 },
      { platform: "instagram", url: null, not_found: true, position: 1 },
    ]);
  });

  it("drops rows that carry neither a URL nor a not-found flag", () => {
    expect(
      parseLinkPayload([
        { platform: "soundcloud", url: "   ", not_found: false, position: 0 },
        { platform: "instagram", url: "https://www.instagram.com/x", not_found: false, position: 1 },
      ])
    ).toHaveLength(1);
  });

  it("falls back to array index when position is missing", () => {
    const parsed = parseLinkPayload([
      { platform: "soundcloud", url: "https://soundcloud.com/a" },
      { platform: "bandcamp", url: "https://x.bandcamp.com" },
    ]);
    expect(parsed.map((r) => r.position)).toEqual([0, 1]);
  });
});

describe("parseLinkPayload — the legacy map shape", () => {
  it("still reads a payload written by the old per-platform forms", () => {
    // A revision sitting in the queue at deploy time was written by a form
    // that no longer exists — see api/revise.
    expect(
      parseLinkPayload({
        soundcloud: "https://soundcloud.com/a",
        instagram: "https://www.instagram.com/b",
      })
    ).toEqual([
      { platform: "soundcloud", url: "https://soundcloud.com/a", not_found: false, position: 0 },
      { platform: "instagram", url: "https://www.instagram.com/b", not_found: false, position: 1 },
    ]);
  });

  it("ignores empty values in a legacy map", () => {
    expect(parseLinkPayload({ soundcloud: "", instagram: "  " })).toEqual([]);
  });

  it("returns nothing for a malformed payload instead of throwing", () => {
    expect(parseLinkPayload(null)).toEqual([]);
    expect(parseLinkPayload(undefined)).toEqual([]);
    expect(parseLinkPayload("nonsense")).toEqual([]);
    expect(parseLinkPayload(42)).toEqual([]);
  });
});

describe("resolveLinkPayload — deriving the platform server-side", () => {
  it("derives from the URL, not from what the client claimed", () => {
    const { rows } = resolveLinkPayload([
      row({ platform: "bandcamp", url: "https://soundcloud.com/a", position: 0 }),
    ]);
    expect(rows[0]).toMatchObject({ platform: "soundcloud", kind: "primary" });
  });

  it("honours a client claim only where detection has no answer", () => {
    // homepage is the case this exists for: first-class, never host-detectable.
    const { rows } = resolveLinkPayload([
      row({ platform: "homepage", url: "https://her-own-site.de", position: 0 }),
    ]);
    expect(rows[0]).toMatchObject({ platform: "homepage" });
  });

  it("overflows a second link on a taken host", () => {
    const { rows } = resolveLinkPayload([
      row({ platform: "soundcloud", url: "https://soundcloud.com/artist", position: 0 }),
      row({ platform: "soundcloud", url: "https://soundcloud.com/label", position: 1 }),
    ]);
    expect(rows.map((r) => r.platform)).toEqual(["soundcloud", "other"]);
    expect(rows[1].kind).toBe("overflow");
  });

  it("keeps several overflow rows, which the old unique constraint forbade", () => {
    const { rows } = resolveLinkPayload([
      row({ url: "https://soundcloud.com/artist", position: 0 }),
      row({ url: "https://soundcloud.com/label", position: 1 }),
      row({ url: "https://some-blog.de/x", position: 2 }),
    ]);
    expect(rows.filter((r) => r.platform === "other")).toHaveLength(2);
  });

  it("rejects a refused host instead of filing it under other", () => {
    const { rows, rejected } = resolveLinkPayload([
      row({ url: "https://twitter.com/someone", position: 0 }),
    ]);
    expect(rows).toEqual([]);
    expect(rejected).toEqual([
      { url: "https://twitter.com/someone", position: 0, kind: "refused" },
    ]);
  });

  it("rejects a bare handle, which has no host to detect", () => {
    const { rejected } = resolveLinkPayload([row({ url: "techno_blondy", position: 0 })]);
    expect(rejected[0].kind).toBe("not-a-url");
  });

  it("preserves list order", () => {
    const { rows } = resolveLinkPayload([
      row({ url: "https://www.instagram.com/b", position: 0 }),
      row({ url: "https://soundcloud.com/a", position: 1 }),
    ]);
    expect(rows.map((r) => r.platform)).toEqual(["instagram", "soundcloud"]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });
});

describe("resolveLinkPayload — not-found markers", () => {
  it("keeps a marker for a platform with no link", () => {
    const { rows } = resolveLinkPayload([
      row({ platform: "instagram", not_found: true, position: 0 }),
    ]);
    expect(rows).toEqual([
      { platform: "instagram", url: null, not_found: true, position: 0, kind: "marker" },
    ]);
  });

  it("drops a marker for a platform a real link claims, so the insert survives", () => {
    // The editor's own guard stops this being submitted; this is the backstop
    // that keeps the partial unique index from rejecting the whole batch.
    const { rows } = resolveLinkPayload([
      row({ platform: "soundcloud", url: "https://soundcloud.com/a", position: 0 }),
      row({ platform: "soundcloud", not_found: true, position: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "soundcloud", not_found: false });
  });

  it("keeps a marker when the same host only appears as an overflow row", () => {
    // An overflow row sits under "other", so the platform itself is genuinely
    // unclaimed — the proposal's "an other row on the same host doesn't block
    // marking it not-found".
    const { rows } = resolveLinkPayload([
      row({ platform: "homepage", url: "https://her-own-site.de", position: 0 }),
      row({ platform: "instagram", not_found: true, position: 1 }),
    ]);
    expect(rows.filter((r) => r.not_found)).toHaveLength(1);
  });

  it("keeps only one marker per platform", () => {
    const { rows } = resolveLinkPayload([
      row({ platform: "instagram", not_found: true, position: 0 }),
      row({ platform: "instagram", not_found: true, position: 1 }),
    ]);
    expect(rows).toHaveLength(1);
  });
});
