import { describe, it, expect } from "vitest";
import { decideHoerLinkCopy, buildHoerLinkRow, HOER } from "./hoer-links.mjs";

describe("decideHoerLinkCopy", () => {
  it("copies when the survivor has no hoer link yet", () => {
    expect(decideHoerLinkCopy("https://hoer.live/artist/x/", undefined).action).toBe("copy");
    expect(decideHoerLinkCopy("https://hoer.live/artist/x/", null).action).toBe("copy");
  });

  it("skips when the survivor already has the same link (idempotent)", () => {
    const url = "https://hoer.live/artist/x/";
    expect(decideHoerLinkCopy(url, url).action).toBe("skip");
  });

  it("flags a conflict when the survivor already has a different link", () => {
    const d = decideHoerLinkCopy(
      "https://hoer.live/artist/x/",
      "https://hoer.live/artist/x-2/"
    );
    expect(d.action).toBe("conflict");
    expect(d.note).toContain("x-2");
  });

  it("treats a null/undefined source url as empty string for comparison", () => {
    // survivor already assigned "" -> a null source is the 'same' -> skip
    expect(decideHoerLinkCopy(null, "").action).toBe("skip");
    // survivor has a real url, source is empty -> different -> conflict
    expect(decideHoerLinkCopy(null, "https://hoer.live/artist/x/").action).toBe("conflict");
  });
});

describe("buildHoerLinkRow", () => {
  it("preserves handle / url / original_url / not_found and sets platform", () => {
    const row = buildHoerLinkRow("artist-1", {
      url: "https://hoer.live/artist/x/",
      handle: "x",
      original_url: "https://hoer.live/x-orig/",
      not_found: true,
    });
    expect(row).toEqual({
      artist_id: "artist-1",
      platform: HOER,
      handle: "x",
      url: "https://hoer.live/artist/x/",
      original_url: "https://hoer.live/x-orig/",
      not_found: true,
    });
  });

  it("defaults missing fields (null handle/url/original_url, not_found=false)", () => {
    const row = buildHoerLinkRow("artist-1", { url: "https://hoer.live/artist/x/" });
    expect(row.handle).toBeNull();
    expect(row.original_url).toBeNull();
    expect(row.not_found).toBe(false);
  });
});
