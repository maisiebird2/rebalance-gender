import { describe, it, expect } from "vitest";
import {
  assignPlatforms,
  isLinkError,
  isUnstorable,
  type LinkAssignmentKind,
} from "./assign-platforms";

/** Shorthand: assign a list of plain URLs and read back [platform, kind]. */
function assign(urls: string[]) {
  return assignPlatforms(urls.map((url) => ({ url }))).map((r) => [r.platform, r.kind]);
}

describe("assignPlatforms — the first-wins rule", () => {
  it("gives each known host its platform", () => {
    expect(
      assign([
        "https://soundcloud.com/some-dj",
        "https://www.instagram.com/techno_blondy",
        "https://ra.co/dj/dianamay",
      ])
    ).toEqual([
      ["soundcloud", "primary"],
      ["instagram", "primary"],
      ["resident_advisor", "primary"],
    ]);
  });

  it("files a second link on the same host as overflow, naming the taken slot", () => {
    const rows = assignPlatforms([
      { url: "https://soundcloud.com/the-artist" },
      { url: "https://soundcloud.com/their-label" },
    ]);
    expect(rows[0]).toMatchObject({ platform: "soundcloud", kind: "primary" });
    expect(rows[1]).toMatchObject({
      platform: "other",
      kind: "overflow",
      occupiedPlatform: "soundcloud",
    });
  });

  it("overflows every link after the first, not just the second", () => {
    expect(
      assign([
        "https://soundcloud.com/a",
        "https://soundcloud.com/b",
        "https://soundcloud.com/c",
      ])
    ).toEqual([
      ["soundcloud", "primary"],
      ["other", "overflow"],
      ["other", "overflow"],
    ]);
  });

  it("treats hosts on the same platform as one slot, whichever alias is used", () => {
    expect(assign(["https://youtu.be/abc", "https://www.youtube.com/@chan"])).toEqual([
      ["youtube", "primary"],
      ["other", "overflow"],
    ]);
  });

  it("files an unrecognised host under other, without claiming a slot", () => {
    expect(assign(["https://some-personal-site.de/about"])).toEqual([
      ["other", "unrecognised"],
    ]);
  });

  it("never treats other as a slot, so unrecognised hosts do not overflow", () => {
    expect(
      assign(["https://one-site.de", "https://another-site.fr", "https://third.example"])
    ).toEqual([
      ["other", "unrecognised"],
      ["other", "unrecognised"],
      ["other", "unrecognised"],
    ]);
  });

  it("auto-promotes the next same-host link when the primary is removed", () => {
    const before = ["https://soundcloud.com/first", "https://soundcloud.com/second"];
    expect(assign(before)).toEqual([
      ["soundcloud", "primary"],
      ["other", "overflow"],
    ]);
    // Delete row 0 and re-run — nothing else happens, the fold just re-runs.
    expect(assign(before.slice(1))).toEqual([["soundcloud", "primary"]]);
  });

  it("is decided by list order, so reordering moves the primary", () => {
    expect(assign(["https://soundcloud.com/label", "https://soundcloud.com/artist"])[0]).toEqual([
      "soundcloud",
      "primary",
    ]);
    expect(assign(["https://soundcloud.com/artist", "https://soundcloud.com/label"])[1]).toEqual([
      "other",
      "overflow",
    ]);
  });
});

describe("assignPlatforms — rows that cannot be stored", () => {
  it("marks a blank row blank", () => {
    expect(assign(["", "   "])).toEqual([
      [null, "blank"],
      [null, "blank"],
    ]);
  });

  it("refuses a policy-excluded host instead of filing it under other", () => {
    expect(assign(["https://twitter.com/someone"])).toEqual([[null, "refused"]]);
    expect(assign(["https://x.com/someone"])).toEqual([[null, "refused"]]);
    expect(assign(["https://t.co/abc"])).toEqual([[null, "refused"]]);
  });

  it("separates a bare handle from a refused host", () => {
    // Both classify as null; only the shape check tells them apart, and they
    // need different messages.
    expect(assign(["techno_blondy"])).toEqual([[null, "not-a-url"]]);
    expect(assign(["mailto:someone@example.com"])).toEqual([[null, "not-a-url"]]);
  });

  it("does not let an unstorable row claim or consume a slot", () => {
    expect(
      assign([
        "https://twitter.com/someone",
        "not a url",
        "",
        "https://soundcloud.com/the-artist",
      ])
    ).toEqual([
      [null, "refused"],
      [null, "not-a-url"],
      [null, "blank"],
      ["soundcloud", "primary"],
    ]);
  });

  it("classifies through an Instagram link shim", () => {
    expect(
      assign(["https://l.instagram.com/?u=https%3A%2F%2Fsoundcloud.com%2Fthe-artist"])
    ).toEqual([["soundcloud", "primary"]]);
  });

  it("detects the platform keys that only got domains with this work", () => {
    expect(assign(["https://hoer.live/artist/someone"])).toEqual([["hoer", "primary"]]);
    expect(assign(["https://djanes.net/dj/someone"])).toEqual([["djanes", "primary"]]);
    expect(assign(["https://www.1001tracklists.com/dj/someone/"])).toEqual([
      ["1001tracklists", "primary"],
    ]);
  });
});

describe("assignPlatforms — stored rows", () => {
  it("keeps a stored platform detection cannot reproduce", () => {
    // The permanent case: homepage is first-class and never host-detectable.
    expect(
      assignPlatforms([
        { url: "https://her-own-site.de", storedPlatform: "homepage" },
      ])[0]
    ).toMatchObject({ platform: "homepage", kind: "primary" });
  });

  it("lets a stored row occupy its slot, so a later same-host row overflows", () => {
    const rows = assignPlatforms([
      { url: "https://soundcloud.com/stored", storedPlatform: "soundcloud" },
      { url: "https://soundcloud.com/pasted" },
    ]);
    expect(rows[1]).toMatchObject({ platform: "other", kind: "overflow" });
  });

  it("re-derives once the stored platform is cleared, which is what editing does", () => {
    const edited = assignPlatforms([
      { url: "https://www.instagram.com/someone", storedPlatform: null },
    ]);
    expect(edited[0]).toMatchObject({ platform: "instagram", kind: "primary" });
  });

  it("explains a stored other row as overflow only when its host is taken", () => {
    const overflow = assignPlatforms([
      { url: "https://soundcloud.com/artist", storedPlatform: "soundcloud" },
      { url: "https://soundcloud.com/label", storedPlatform: "other" },
    ]);
    expect(overflow[1]).toMatchObject({ kind: "overflow", occupiedPlatform: "soundcloud" });

    const unrecognised = assignPlatforms([
      { url: "https://some-blog.de/x", storedPlatform: "other" },
    ]);
    expect(unrecognised[0]).toMatchObject({ platform: "other", kind: "unrecognised" });
  });

  it("still refuses a policy-excluded stored row rather than re-saving it", () => {
    expect(
      assignPlatforms([{ url: "https://twitter.com/someone", storedPlatform: "other" }])[0]
    ).toMatchObject({ platform: null, kind: "refused" });
  });

  it("preserves the caller's own fields and the list order", () => {
    const rows = assignPlatforms([
      { id: "row-1", url: "https://soundcloud.com/a", not_found: false },
      { id: "row-2", url: "https://soundcloud.com/b", not_found: false },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["row-1", "row-2"]);
    expect(rows[0].not_found).toBe(false);
  });
});

describe("kind predicates", () => {
  it("treats exactly the unwritable kinds as unstorable", () => {
    const unwritable: LinkAssignmentKind[] = ["blank", "not-a-url", "refused"];
    const writable: LinkAssignmentKind[] = ["primary", "overflow", "unrecognised"];
    expect(unwritable.every(isUnstorable)).toBe(true);
    expect(writable.some(isUnstorable)).toBe(false);
  });

  it("counts only the ones someone must fix as errors", () => {
    expect(isLinkError("blank")).toBe(false);
    expect(isLinkError("not-a-url")).toBe(true);
    expect(isLinkError("refused")).toBe(true);
    expect(isLinkError("overflow")).toBe(false);
  });
});
