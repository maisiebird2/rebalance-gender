import { describe, it, expect } from "vitest";
import {
  deriveLinkEditorState,
  editLinkRow,
  hasLinkErrors,
  linkEditorStateFromLinks,
  markableNotFoundPlatforms,
  newLinkRow,
  serializeLinkRows,
  type LinkEditorState,
} from "./link-rows";

function state(partial: Partial<LinkEditorState>): LinkEditorState {
  return { rows: [], homepage: "", notFound: [], ...partial };
}

describe("linkEditorStateFromLinks", () => {
  it("lifts the homepage out of the list, since nothing can detect it", () => {
    const s = linkEditorStateFromLinks([
      { platform: "homepage", url: "https://her-own-site.de" },
      { platform: "soundcloud", url: "https://soundcloud.com/a" },
    ]);
    expect(s.homepage).toBe("https://her-own-site.de");
    expect(s.rows.map((r) => r.text)).toEqual(["https://soundcloud.com/a"]);
  });

  it("carries the stored platform, so a loaded row keeps it", () => {
    const s = linkEditorStateFromLinks([{ platform: "djanes", url: "https://djanes.net/dj/x" }]);
    expect(s.rows[0].storedPlatform).toBe("djanes");
  });

  it("collects not-found markers separately from links", () => {
    const s = linkEditorStateFromLinks([
      { platform: "instagram", url: null, not_found: true },
      { platform: "soundcloud", url: "https://soundcloud.com/a" },
    ]);
    expect(s.notFound).toEqual(["instagram"]);
    expect(s.rows).toHaveLength(1);
  });

  it("shows the canonical url by default and the original when asked", () => {
    const links = [
      { platform: "soundcloud", url: "https://soundcloud.com/real", original_url: "https://on.soundcloud.com/xyz" },
    ];
    expect(linkEditorStateFromLinks(links).rows[0].text).toBe("https://soundcloud.com/real");
    expect(linkEditorStateFromLinks(links, "original").rows[0].text).toBe(
      "https://on.soundcloud.com/xyz"
    );
  });

  it("copes with an artist that has no links", () => {
    expect(linkEditorStateFromLinks(null)).toEqual({ rows: [], homepage: "", notFound: [] });
  });
});

describe("editLinkRow", () => {
  it("drops the stored platform, so the row re-derives from what was typed", () => {
    const row = newLinkRow("https://soundcloud.com/a", "homepage");
    expect(editLinkRow(row, "https://www.instagram.com/b").storedPlatform).toBeNull();
  });

  it("keeps the row's identity, so the field doesn't lose focus", () => {
    const row = newLinkRow("a");
    expect(editLinkRow(row, "b").id).toBe(row.id);
  });
});

describe("deriveLinkEditorState", () => {
  it("counts the homepage as holding its platform", () => {
    const derived = deriveLinkEditorState(state({ homepage: "https://her-own-site.de" }));
    expect(derived.homepage.platform).toBe("homepage");
    expect(derived.primaryPlatforms.has("homepage")).toBe(true);
  });

  it("derives the list in order, so the second link on a host overflows", () => {
    const derived = deriveLinkEditorState(
      state({
        rows: [newLinkRow("https://soundcloud.com/a"), newLinkRow("https://soundcloud.com/b")],
      })
    );
    expect(derived.rows.map((r) => r.kind)).toEqual(["primary", "overflow"]);
  });

  it("does not count an overflow row as holding the platform", () => {
    const derived = deriveLinkEditorState(
      state({ rows: [newLinkRow("https://some-blog.de/x")] })
    );
    expect(derived.primaryPlatforms.has("other")).toBe(false);
  });
});

describe("hasLinkErrors", () => {
  it("is false for an empty form", () => {
    expect(hasLinkErrors(state({ rows: [newLinkRow()] }))).toBe(false);
  });

  it("is true for a refused host", () => {
    expect(hasLinkErrors(state({ rows: [newLinkRow("https://x.com/someone")] }))).toBe(true);
  });

  it("is true for a bare handle", () => {
    expect(hasLinkErrors(state({ rows: [newLinkRow("techno_blondy")] }))).toBe(true);
  });

  it("catches a bad homepage too", () => {
    expect(hasLinkErrors(state({ homepage: "her-own-site.de" }))).toBe(true);
  });

  it("is false for an overflow row, which is saved rather than fixed", () => {
    expect(
      hasLinkErrors(
        state({
          rows: [newLinkRow("https://soundcloud.com/a"), newLinkRow("https://soundcloud.com/b")],
        })
      )
    ).toBe(false);
  });
});

describe("markableNotFoundPlatforms", () => {
  const keys = ["homepage", "soundcloud", "instagram", "other"];

  it("offers platforms with no link and no marker", () => {
    expect(markableNotFoundPlatforms(state({}), keys)).toEqual([
      "homepage",
      "soundcloud",
      "instagram",
    ]);
  });

  it("never offers the overflow bucket", () => {
    expect(markableNotFoundPlatforms(state({}), keys)).not.toContain("other");
  });

  it("drops a platform that already has a link", () => {
    const s = state({ rows: [newLinkRow("https://soundcloud.com/a")] });
    expect(markableNotFoundPlatforms(s, keys)).not.toContain("soundcloud");
  });

  it("drops one already marked", () => {
    expect(markableNotFoundPlatforms(state({ notFound: ["instagram"] }), keys)).not.toContain(
      "instagram"
    );
  });

  it("still offers a platform that only appears as an overflow row", () => {
    // An "other" row means the platform's own slot is still empty.
    const s = state({
      rows: [newLinkRow("https://soundcloud.com/a"), newLinkRow("https://soundcloud.com/b")],
    });
    expect(markableNotFoundPlatforms(s, ["instagram"])).toContain("instagram");
  });
});

describe("serializeLinkRows", () => {
  it("puts the homepage first and the markers last", () => {
    const payload = serializeLinkRows(
      state({
        homepage: "https://her-own-site.de",
        rows: [newLinkRow("https://soundcloud.com/a")],
        notFound: ["instagram"],
      })
    );
    expect(payload.map((r) => r.platform)).toEqual(["homepage", "", "instagram"]);
    expect(payload.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(payload[2]).toMatchObject({ url: null, not_found: true });
  });

  it("drops blank rows", () => {
    const payload = serializeLinkRows(
      state({ rows: [newLinkRow("  "), newLinkRow("https://soundcloud.com/a"), newLinkRow("")] })
    );
    expect(payload).toHaveLength(1);
  });

  it("sends a stored platform so the server can honour an undetectable one", () => {
    const payload = serializeLinkRows(
      state({ rows: [newLinkRow("https://her-label.de", "homepage")] })
    );
    expect(payload[0].platform).toBe("homepage");
  });

  it("sends no platform for a row that was typed, leaving it to the server", () => {
    const payload = serializeLinkRows(state({ rows: [newLinkRow("https://soundcloud.com/a")] }));
    expect(payload[0].platform).toBe("");
  });

  it("drops a marker for a platform that now has a link", () => {
    // Someone pasting a SoundCloud link shouldn't also have to clear the
    // "not on SoundCloud" chip they set earlier.
    const payload = serializeLinkRows(
      state({ rows: [newLinkRow("https://soundcloud.com/a")], notFound: ["soundcloud"] })
    );
    expect(payload.filter((r) => r.not_found)).toHaveLength(0);
  });

  it("keeps a marker whose platform only appears as an overflow row", () => {
    const payload = serializeLinkRows(
      state({
        homepage: "https://her-own-site.de",
        rows: [newLinkRow("https://an-unknown-host.de/x")],
        notFound: ["soundcloud"],
      })
    );
    expect(payload.filter((r) => r.not_found).map((r) => r.platform)).toEqual(["soundcloud"]);
  });

  it("produces an empty payload for an untouched form", () => {
    expect(serializeLinkRows(state({ rows: [newLinkRow()] }))).toEqual([]);
  });
});
