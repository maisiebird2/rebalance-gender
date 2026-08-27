import { describe, it, expect } from "vitest";
import {
  linkKey,
  selectSingleLinkDupeSoftDeletes,
  SOFT_DELETE_AUDIT_COLUMNS,
} from "./single-link-dupes.mjs";

const HOER_A = "https://hoer.live/artist/nala/";
const HOER_B = "https://hoer.live/artist/other/";
const SC_A = "https://soundcloud.com/nala";

// Build the { links, artists } input from a compact description. Each spec is
// { id, status, deleted?, name?, links: [[platform, url], ...] }.
function makeInput(specs) {
  const links = [];
  const artists = new Map();
  for (const s of specs) {
    artists.set(s.id, {
      id: s.id,
      name: s.name ?? s.id,
      directory_status: s.status,
      deleted: s.deleted ?? false,
    });
    for (const [platform, url] of s.links ?? []) {
      links.push({ artist_id: s.id, platform, url });
    }
  }
  return { links, artists };
}

const select = (specs, platform = null) =>
  selectSingleLinkDupeSoftDeletes({ ...makeInput(specs), platform });

describe("linkKey", () => {
  it("ignores scheme, www and a trailing slash", () => {
    expect(linkKey("bandcamp", "http://www.x.bandcamp.com/")).toBe(
      linkKey("bandcamp", "https://x.bandcamp.com")
    );
  });

  it("ignores tracking params", () => {
    expect(linkKey("spotify", "https://open.spotify.com/artist/1?si=abc&nd=1")).toBe(
      linkKey("spotify", "https://open.spotify.com/artist/1")
    );
  });

  it("keeps the same url on different platforms apart", () => {
    expect(linkKey("hoer", HOER_A)).not.toBe(linkKey("soundcloud", HOER_A));
  });

  it("does not fold path case — paths are case-sensitive", () => {
    expect(linkKey("discogs", "https://discogs.com/artist/1-Nala")).not.toBe(
      linkKey("discogs", "https://discogs.com/artist/1-nala")
    );
  });

  it("returns null when there is no url to key on", () => {
    expect(linkKey("hoer", null)).toBeNull();
    expect(linkKey("hoer", "   ")).toBeNull();
  });
});

describe("selectSingleLinkDupeSoftDeletes", () => {
  it("soft-deletes a single-link artist whose link an approved artist holds", () => {
    const { toSoftDelete, audit } = select([
      { id: "stub", status: "pending", links: [["hoer", HOER_A]] },
      { id: "live", status: "approved", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
    ]);
    expect(toSoftDelete).toEqual(["stub"]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      artist_id: "stub",
      action: "to-soft-delete",
      sharer_id: "live",
      platform: "hoer",
      url: HOER_A,
      link_count: 1,
    });
  });

  it("works the same on any platform, not just hoer", () => {
    const { toSoftDelete, audit } = select([
      { id: "stub", status: "sc_followee", links: [["soundcloud", SC_A]] },
      { id: "live", status: "approved", links: [["soundcloud", SC_A]] },
    ]);
    expect(toSoftDelete).toEqual(["stub"]);
    expect(audit[0].platform).toBe("soundcloud");
  });

  it("matches urls that differ only by scheme, www or a trailing slash", () => {
    const { toSoftDelete } = select([
      { id: "stub", status: "pending", links: [["bandcamp", "http://www.x.bandcamp.com/"]] },
      { id: "live", status: "approved", links: [["bandcamp", "https://x.bandcamp.com"]] },
    ]);
    expect(toSoftDelete).toEqual(["stub"]);
  });

  it("never matches across platforms", () => {
    const { toSoftDelete } = select([
      { id: "stub", status: "pending", links: [["hoer", HOER_A]] },
      { id: "live", status: "approved", links: [["soundcloud", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
  });

  it("never deletes an artist that has a second link", () => {
    const { toSoftDelete, audit } = select([
      { id: "two-links", status: "pending", links: [["hoer", HOER_A], ["bandcamp", "https://b.com"]] },
      { id: "live", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
    // The two-link row is not a candidate. The approved one-link row is, but
    // its only sharer is fuller yet not in the directory — incomparable.
    expect(audit.map((r) => r.artist_id)).toEqual(["live"]);
    expect(audit[0].action).toBe("skipped");
    expect(audit[0].note).toContain("merge by hand");
  });

  it("flags, rather than deletes, two equally bare rows of the same status", () => {
    const { toSoftDelete, audit } = select([
      { id: "stub", status: "pending", links: [["hoer", HOER_A]] },
      { id: "other-stub", status: "pending", links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
    expect(audit.map((r) => r.artist_id)).toEqual(["other-stub", "stub"]);
    expect(audit.every((r) => r.action === "skipped")).toBe(true);
    expect(audit[0].note).toContain("pick a survivor by hand");
  });

  it("deletes a bare row for a fuller one when NEITHER is approved", () => {
    // The Hacker: two not_eligible rows on one HÖR link, 1 link vs 6. The
    // fuller row wins on links; status is equal, so it dominates.
    const { toSoftDelete, audit } = select([
      { id: "bare", name: "The Hacker", status: "not_eligible", links: [["hoer", HOER_A]] },
      {
        id: "full",
        name: "The Hacker",
        status: "not_eligible",
        links: [["hoer", HOER_A], ["soundcloud", SC_A], ["bandcamp", "https://b.com"]],
      },
    ]);
    expect(toSoftDelete).toEqual(["bare"]);
    expect(audit[0].note).toContain("The Hacker (not_eligible, 3 links)");
  });

  it("keeps an approved row over an equally bare non-approved one, silently", () => {
    // The approved row outranks its sharer on status and ties on links, so it
    // is the survivor — not a problem, and not worth a row in the audit.
    const { toSoftDelete, audit } = select([
      { id: "approved-row", status: "approved", links: [["hoer", HOER_A]] },
      { id: "pending-row", status: "pending", links: [["hoer", HOER_A]] },
    ]);
    // The pending row loses on status and is deleted; the approved one is not
    // reported at all.
    expect(toSoftDelete).toEqual(["pending-row"]);
    expect(audit.map((r) => r.artist_id)).toEqual(["pending-row"]);
  });

  it("keeps a stub whose only sharer is soft-deleted", () => {
    const { toSoftDelete } = select([
      { id: "stub", status: "pending", links: [["hoer", HOER_A]] },
      { id: "gone", status: "approved", deleted: true, links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
  });

  it("does not treat an artist as its own sharer", () => {
    const { toSoftDelete, audit } = select([
      { id: "solo", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("deletes an approved single-link row when an approved sharer holds more", () => {
    const { toSoftDelete, audit } = select([
      { id: "approved-stub", status: "approved", links: [["hoer", HOER_A]] },
      { id: "live", name: "Live", status: "approved", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
    ]);
    expect(toSoftDelete).toEqual(["approved-stub"]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "to-soft-delete",
      sharer_link_count: "2",
    });
    expect(audit[0].note).toContain("Live (approved, 2 links)");
  });

  it("flags a tie — two approved rows that both hold only the one link", () => {
    const { toSoftDelete, audit } = select([
      { id: "a", status: "approved", links: [["hoer", HOER_A]] },
      { id: "b", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
    expect(audit.map((r) => r.artist_id)).toEqual(["a", "b"]);
    expect(audit.every((r) => r.action === "skipped")).toBe(true);
    expect(audit[0].note).toContain("by hand");
  });

  it("clears every bare approved row in a cluster, keeping the fuller one", () => {
    // Two stubs and one real entry, all approved, all on the same link: both
    // stubs go, the entry with the other links survives.
    const { toSoftDelete } = select([
      { id: "stub-1", status: "approved", links: [["hoer", HOER_A]] },
      { id: "stub-2", status: "approved", links: [["hoer", HOER_A]] },
      { id: "real", status: "approved", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
    ]);
    expect(toSoftDelete).toEqual(["stub-1", "stub-2"]);
  });

  it("does not let a soft-deleted fuller row justify deleting a live approved one", () => {
    const { toSoftDelete, audit } = select([
      { id: "approved-stub", status: "approved", links: [["hoer", HOER_A]] },
      {
        id: "gone",
        status: "approved",
        deleted: true,
        links: [["hoer", HOER_A], ["soundcloud", SC_A]],
      },
    ]);
    // The only sharer is soft-deleted, so there is no sharer at all.
    expect(toSoftDelete).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("flags — never deletes — an approved row whose fuller twin is not approved", () => {
    // Deleting the approved row would drop the artist from the public site
    // altogether, since the fuller row is not in the directory. A merge
    // decision, not a delete.
    const { toSoftDelete, audit } = select([
      { id: "approved-stub", status: "approved", links: [["hoer", HOER_A]] },
      { id: "pending-rich", status: "pending", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
    expect(audit.map((r) => r.artist_id)).toEqual(["approved-stub"]);
    expect(audit[0]).toMatchObject({ action: "skipped", sharer_status: "pending" });
    expect(audit[0].note).toContain("merge by hand");
  });

  it("skips an already soft-deleted candidate instead of touching it again", () => {
    const { toSoftDelete, audit } = select([
      { id: "stub", status: "pending", deleted: true, links: [["hoer", HOER_A]] },
      { id: "live", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
    expect(audit[0]).toMatchObject({ action: "skipped", note: "already soft-deleted" });
  });

  it("skips a link whose artist row is missing", () => {
    const { links, artists } = makeInput([
      { id: "live", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    links.push({ artist_id: "ghost", platform: "hoer", url: HOER_A });
    const { toSoftDelete, audit } = selectSingleLinkDupeSoftDeletes({ links, artists });
    expect(toSoftDelete).toEqual([]);
    expect(audit[0]).toMatchObject({ artist_id: "ghost", action: "skipped" });
  });

  it("ignores a blank url rather than matching every other blank one", () => {
    const { toSoftDelete } = select([
      { id: "stub", status: "pending", links: [["hoer", ""]] },
      { id: "live", status: "approved", links: [["hoer", ""]] },
    ]);
    expect(toSoftDelete).toEqual([]);
  });

  it("counts a sharer's every link, not just a sole one", () => {
    const { toSoftDelete } = select([
      { id: "stub", status: "pending", links: [["soundcloud", SC_A]] },
      {
        id: "live",
        status: "approved",
        links: [["hoer", HOER_A], ["soundcloud", SC_A], ["bandcamp", "https://b.com"]],
      },
    ]);
    expect(toSoftDelete).toEqual(["stub"]);
  });

  it("collects every sharer of one link", () => {
    const { toSoftDelete, audit } = select([
      { id: "stub", status: "pending", links: [["hoer", HOER_A]] },
      // A second link each, so the approved pair are sharers rather than
      // single-link candidates in their own right.
      { id: "live-1", name: "One", status: "approved", links: [["hoer", HOER_A], ["bandcamp", "https://one.com"]] },
      { id: "live-2", name: "Two", status: "approved", links: [["hoer", HOER_A], ["bandcamp", "https://two.com"]] },
    ]);
    expect(toSoftDelete).toEqual(["stub"]);
    expect(audit).toHaveLength(1);
    expect(audit[0].sharer_name).toBe("One; Two");
  });

  it("audits each approved member of a tied cluster separately", () => {
    // Three approved artists, one link each, nothing else: a three-way tie,
    // so every one of them is flagged rather than deleted.
    const { toSoftDelete, audit } = select([
      { id: "a", name: "A", status: "approved", links: [["hoer", HOER_A]] },
      { id: "b", name: "B", status: "approved", links: [["hoer", HOER_A]] },
      { id: "c", name: "C", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
    expect(audit.map((r) => r.artist_id)).toEqual(["a", "b", "c"]);
    expect(audit[0].sharer_name).toBe("B; C");
    expect(audit.every((r) => r.action === "skipped")).toBe(true);
  });

  it("keys candidates by url, so a different link is untouched", () => {
    const { toSoftDelete } = select([
      { id: "stub", status: "pending", links: [["hoer", HOER_B]] },
      { id: "live", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    expect(toSoftDelete).toEqual([]);
  });

  it("considers every platform by default", () => {
    const { toSoftDelete } = select([
      { id: "hoer-stub", status: "pending", links: [["hoer", HOER_A]] },
      { id: "sc-stub", status: "pending", links: [["soundcloud", SC_A]] },
      { id: "live", status: "approved", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
    ]);
    expect(toSoftDelete).toEqual(["hoer-stub", "sc-stub"]);
  });

  it("restricts candidates to one platform when asked", () => {
    const specs = [
      { id: "hoer-stub", status: "pending", links: [["hoer", HOER_A]] },
      { id: "sc-stub", status: "pending", links: [["soundcloud", SC_A]] },
      { id: "live", status: "approved", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
    ];
    expect(select(specs, "soundcloud").toSoftDelete).toEqual(["sc-stub"]);
    expect(select(specs, "hoer").toSoftDelete).toEqual(["hoer-stub"]);
  });

  it("narrowing to a platform does not narrow who counts as a sharer", () => {
    // The approved artist's OTHER links are irrelevant to the filter; what
    // matters is that it holds this stub's soundcloud link.
    const { toSoftDelete } = select(
      [
        { id: "stub", status: "pending", links: [["soundcloud", SC_A]] },
        { id: "live", status: "approved", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
      ],
      "soundcloud"
    );
    expect(toSoftDelete).toEqual(["stub"]);
  });

  it("never leaves a link with no holder at all", () => {
    // The safety invariant: a row is only deleted because some sharer beats
    // it outright, and "beats outright" is a strict partial order, so every
    // link's holder set has a maximal element that nothing dominates. That
    // row is never deleted — by this link or any other.
    const specs = [
      { id: "stub-1", status: "approved", links: [["hoer", HOER_A]] },
      { id: "stub-2", status: "approved", links: [["hoer", HOER_A]] },
      { id: "real", status: "approved", links: [["hoer", HOER_A], ["soundcloud", SC_A]] },
      { id: "sc-stub", status: "approved", links: [["soundcloud", SC_A]] },
    ];
    const { toSoftDelete } = select(specs);
    // "real" shares hoer with the stubs AND soundcloud with sc-stub, so it is
    // the survivor on both links; it has two links, so it is never a candidate.
    expect(toSoftDelete).toEqual(["sc-stub", "stub-1", "stub-2"]);
    expect(toSoftDelete).not.toContain("real");
  });

  it("emits audit rows carrying exactly the CSV columns", () => {
    const { audit } = select([
      { id: "stub", status: "pending", links: [["hoer", HOER_A]] },
      { id: "live", status: "approved", links: [["hoer", HOER_A]] },
    ]);
    expect(Object.keys(audit[0]).sort()).toEqual([...SOFT_DELETE_AUDIT_COLUMNS].sort());
  });
});
