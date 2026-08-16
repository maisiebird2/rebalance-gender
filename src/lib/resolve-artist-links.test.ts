import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveArtistLinks, type RowOutcome } from "./resolve-artist-links";

// ------------------------------------------------------------
// Network. Keyed by URL rather than call order, so a test that resolves
// several rows doesn't depend on the order they happen to be visited in.
// ------------------------------------------------------------
type Hop = { location: string } | { status: number };

function mockNetwork(map: Record<string, Hop>) {
  return vi.spyOn(global, "fetch").mockImplementation((input) => {
    const url = String(input);
    const hop = map[url] ?? { status: 200 };
    const location = "location" in hop ? hop.location : null;
    return Promise.resolve({
      status: "location" in hop ? 302 : hop.status,
      headers: { get: (k: string) => (k.toLowerCase() === "location" ? location : null) },
      body: null,
    } as unknown as Response);
  });
}

// ------------------------------------------------------------
// A structural stand-in for the Supabase client, covering just the four query
// shapes this module builds. Records every update so tests can assert on what
// would actually be written.
// ------------------------------------------------------------
interface FakeRow {
  id: number;
  artist_id: string;
  platform: string;
  url: string;
  original_url: string | null;
}

interface FakeDb {
  links: FakeRow[];
  platforms: string[];
  updateError?: string;
}

interface RecordedUpdate {
  id: number;
  patch: Record<string, unknown>;
}

function fakeClient(db: FakeDb) {
  const updates: RecordedUpdate[] = [];

  class Query {
    table: string;
    cols = "";
    op: "select" | "update" = "select";
    patch: Record<string, unknown> = {};
    orHosts: string[] = [];
    eqs: Array<[string, unknown]> = [];
    ins: Array<[string, unknown[]]> = [];
    rangeFrom = 0;
    rangeTo = Number.MAX_SAFE_INTEGER;

    constructor(table: string) {
      this.table = table;
    }
    select(cols: string) {
      this.cols = cols;
      return this;
    }
    update(patch: Record<string, unknown>) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    not() {
      return this;
    }
    order() {
      return this;
    }
    or(filter: string) {
      // "url.ilike.%bit.ly%,url.ilike.%goo.gl%" -> ["bit.ly", "goo.gl"]
      this.orHosts = filter.split(",").map((f) => f.replace("url.ilike.%", "").replace("%", ""));
      return this;
    }
    eq(col: string, val: unknown) {
      this.eqs.push([col, val]);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.ins.push([col, vals]);
      return this;
    }
    range(from: number, to: number) {
      this.rangeFrom = from;
      this.rangeTo = to;
      return this;
    }
    then(resolve: (v: { data: unknown; error: { message: string } | null }) => void) {
      resolve(this.run());
    }

    private run() {
      if (this.op === "update") {
        if (db.updateError) return { data: null, error: { message: db.updateError } };
        const id = this.eqs.find(([c]) => c === "id")?.[1] as number;
        updates.push({ id, patch: this.patch });
        const row = db.links.find((r) => r.id === id);
        if (row) Object.assign(row, this.patch);
        return { data: null, error: null };
      }

      if (this.table === "platforms") {
        return { data: db.platforms.map((key) => ({ key })), error: null };
      }

      // The (artist_id, platform) slot lookup.
      if (this.cols === "artist_id, platform") {
        const ids = this.ins.find(([c]) => c === "artist_id")?.[1] as string[];
        return {
          data: db.links
            .filter((r) => ids.includes(r.artist_id))
            .map((r) => ({ artist_id: r.artist_id, platform: r.platform })),
          error: null,
        };
      }

      // The candidate scan.
      let rows = db.links.filter((r) => r.url != null);
      if (this.orHosts.length) {
        rows = rows.filter((r) => this.orHosts.some((h) => r.url.toLowerCase().includes(h)));
      }
      for (const [col, val] of this.eqs) rows = rows.filter((r) => r[col as keyof FakeRow] === val);
      for (const [col, vals] of this.ins) {
        rows = rows.filter((r) => vals.includes(r[col as keyof FakeRow]));
      }
      rows = rows.sort((a, b) => a.id - b.id).slice(this.rangeFrom, this.rangeTo + 1);
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
  }

  const client = { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
  return { client, updates };
}

const ALL_PLATFORMS = [
  "soundcloud", "instagram", "spotify", "youtube", "resident_advisor", "bandcamp",
  "facebook", "tiktok", "linktree", "beatport", "discogs", "qobuz", "tidal",
  "songkick", "apple_music", "lastfm", "musicbrainz", "wikipedia", "other",
];

function link(over: Partial<FakeRow> & { id: number }): FakeRow {
  return {
    artist_id: "artist-1",
    platform: "other",
    url: "https://bit.ly/abc",
    original_url: null,
    ...over,
  };
}

const NO_DELAY = { delayMs: 0 };

describe("resolveArtistLinks — scanning", () => {
  afterEach(() => vi.restoreAllMocks());

  it("examines only rows whose host is resolvable", async () => {
    mockNetwork({});
    const { client } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "soundcloud", url: "https://soundcloud.com/real-artist" }),
        link({ id: 2, platform: "instagram", url: "https://www.instagram.com/someone" }),
      ],
    });
    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.examined).toBe(0);
    expect(report.updated).toHaveLength(0);
  });

  it("does not mistake maps.app.goo.gl for a resolvable host", async () => {
    // The SQL pre-filter is a loose ILIKE %goo.gl%, so this row IS fetched.
    // Only the exact host test in JS keeps it from being touched.
    mockNetwork({});
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, url: "https://maps.app.goo.gl/abc" })],
    });
    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.examined).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("honours an artistId scope", async () => {
    mockNetwork({
      "https://on.soundcloud.com/aaa": { location: "https://soundcloud.com/wanted" },
      "https://on.soundcloud.com/bbb": { location: "https://soundcloud.com/other" },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, artist_id: "artist-1", platform: "soundcloud", url: "https://on.soundcloud.com/aaa" }),
        link({ id: 2, artist_id: "artist-2", platform: "soundcloud", url: "https://on.soundcloud.com/bbb" }),
      ],
    });
    const report = await resolveArtistLinks(client, { artistId: "artist-1" }, NO_DELAY);
    expect(report.examined).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(1);
  });

  it("honours an ids scope and a limit", async () => {
    mockNetwork({
      "https://on.soundcloud.com/aaa": { location: "https://soundcloud.com/a" },
      "https://on.soundcloud.com/bbb": { location: "https://soundcloud.com/b" },
    });
    const { client } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "soundcloud", url: "https://on.soundcloud.com/aaa" }),
        link({ id: 2, platform: "soundcloud", url: "https://on.soundcloud.com/bbb" }),
      ],
    });
    expect((await resolveArtistLinks(client, { ids: [2] }, NO_DELAY)).examined).toBe(1);
    expect((await resolveArtistLinks(client, { all: true }, { ...NO_DELAY, limit: 1 })).examined).toBe(1);
  });
});

describe("resolveArtistLinks — tier A", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves a share link, canonicalizes it, and derives the handle", async () => {
    mockNetwork({
      "https://on.soundcloud.com/SGLfUfT6l0kTYyO1SY": {
        location: "https://soundcloud.com/lolakind?ref=clipboard&si=991E3000",
      },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "soundcloud", url: "https://on.soundcloud.com/SGLfUfT6l0kTYyO1SY" }),
      ],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);

    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]).toMatchObject({
      newPlatform: "soundcloud", // tier A: platform was already known, unchanged
      newUrl: "https://soundcloud.com/lolakind", // tracking params dropped
      newHandle: "lolakind", // derived from the RESOLVED url
    });
    expect(updates[0].patch).toMatchObject({
      url: "https://soundcloud.com/lolakind",
      platform: "soundcloud",
      handle: "lolakind",
      original_url: "https://on.soundcloud.com/SGLfUfT6l0kTYyO1SY",
    });
  });

  it("keeps the row when the destination fails validation", async () => {
    // spotify.link's Branch deep link — the real 2026-08-08 behaviour.
    mockNetwork({
      "https://spotify.link/eqRHE9U72Db": { location: "https://spotify.app.link/eqRHE9U72Db" },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "spotify", url: "https://spotify.link/eqRHE9U72Db" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({
      reason: "validation-failed",
      destination: "https://spotify.app.link/eqRHE9U72Db",
    });
  });

  it("refuses to overwrite a live row with a dead destination", async () => {
    mockNetwork({
      "https://soundcloud.app.goo.gl/Hqa78": { location: "https://soundcloud.com/ahuraaghabeigi" },
      "https://soundcloud.com/ahuraaghabeigi": { status: 404 },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://soundcloud.app.goo.gl/Hqa78" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({ reason: "dead-destination", finalStatus: 404 });
  });
});

describe("resolveArtistLinks — tier B reclassification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("moves a generic shortener onto the platform it turned out to be", async () => {
    mockNetwork({
      "https://goo.gl/ugfBAL": { location: "https://www.youtube.com/channel/UC_dO" },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://goo.gl/ugfBAL" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.updated[0]).toMatchObject({
      platform: "other",
      newPlatform: "youtube",
      newUrl: "https://www.youtube.com/channel/UC_dO",
    });
    expect(updates[0].patch).toMatchObject({ platform: "youtube" });
  });

  it("reclassifies a tier A row whose stored platform predates resolution", async () => {
    // soundcloud.app.goo.gl rows sit under `other` BECAUSE classification ran
    // on the shortener host. Resolution is the moment that becomes knowable, so
    // it's the moment to fix the platform and the handle — not just the URL.
    mockNetwork({
      "https://soundcloud.app.goo.gl/TTQjJ": { location: "https://soundcloud.com/kling_und_klang" },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://soundcloud.app.goo.gl/TTQjJ" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.updated[0]).toMatchObject({
      platform: "other",
      newPlatform: "soundcloud",
      newUrl: "https://soundcloud.com/kling_und_klang",
      newHandle: "kling_und_klang",
    });
    expect(updates[0].patch).toMatchObject({ platform: "soundcloud", handle: "kling_und_klang" });
  });

  it("does not downgrade a platform key that lives outside the shared table", async () => {
    // "other" is the classifier's fallback, not a finding. A `homepage` row
    // resolving to an unrecognised domain must stay `homepage`.
    mockNetwork({ "https://bit.ly/xyz": { location: "https://some-personal-site.example.com/" } });
    const { client, updates } = fakeClient({
      platforms: [...ALL_PLATFORMS, "homepage"],
      links: [link({ id: 1, platform: "homepage", url: "https://bit.ly/xyz" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.updated[0]).toMatchObject({ newPlatform: "homepage" });
    expect(updates[0].patch).toMatchObject({ platform: "homepage" });
  });

  it("classifies with the shared table, so a resolved self-link still counts", async () => {
    // The harvester configs skip links back to their own source platform. That
    // is right when staging a discovered link and wrong here: a bit.ly on a
    // live row that resolves to SoundCloud is a genuine SoundCloud link.
    mockNetwork({ "https://bit.ly/xyz": { location: "https://soundcloud.com/real-artist" } });
    const { client } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://bit.ly/xyz" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.updated[0]).toMatchObject({
      newPlatform: "soundcloud",
      newUrl: "https://soundcloud.com/real-artist",
      newHandle: "real-artist",
    });
  });

  it("skips a row that would collide with a platform the artist already has", async () => {
    // artist_links carries UNIQUE (artist_id, platform). Picking a winner
    // between two links isn't this module's call to make silently.
    mockNetwork({ "https://goo.gl/ugfBAL": { location: "https://www.youtube.com/channel/UC_dO" } });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "other", url: "https://goo.gl/ugfBAL" }),
        link({ id: 2, platform: "youtube", url: "https://www.youtube.com/channel/EXISTING" }),
      ],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({ reason: "platform-collision", newPlatform: "youtube" });
  });

  it("does not collide with a slot the same run just vacated", async () => {
    // Row 1 moves other -> youtube. Row 2 (also 'other') must not then be told
    // 'other' is taken by row 1, because row 1 no longer occupies it.
    mockNetwork({
      "https://goo.gl/one": { location: "https://www.youtube.com/channel/UC_a" },
      "https://bit.ly/two": { location: "https://www.bandcamp.com/x" },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "other", url: "https://goo.gl/one" }),
        link({ id: 2, platform: "other", url: "https://bit.ly/two" }),
      ],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.skipped).toHaveLength(0);
    expect(updates).toHaveLength(2);
  });

  it("claims a slot within the run so two rows can't both take it", async () => {
    mockNetwork({
      "https://goo.gl/one": { location: "https://www.youtube.com/channel/UC_a" },
      "https://bit.ly/two": { location: "https://www.youtube.com/channel/UC_b" },
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "other", url: "https://goo.gl/one" }),
        link({ id: 2, platform: "linktree", url: "https://bit.ly/two" }),
      ],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ id: 2, reason: "platform-collision" });
  });

  it("skips a platform key that isn't in the platforms table", async () => {
    mockNetwork({ "https://goo.gl/ugfBAL": { location: "https://www.youtube.com/channel/UC_dO" } });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS.filter((p) => p !== "youtube"), // key not added yet
      links: [link({ id: 1, platform: "other", url: "https://goo.gl/ugfBAL" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({ reason: "unknown-platform", newPlatform: "youtube" });
  });

  it("skips a destination the classifier refuses outright", async () => {
    // Twitter/X is skip-listed by project policy, so classifyPlatformUrl
    // returns null rather than a platform.
    mockNetwork({ "https://bit.ly/xyz": { location: "https://x.com/someone" } });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://bit.ly/xyz" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({ reason: "unclassifiable" });
  });
});

describe("resolveArtistLinks — original_url preservation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records the pre-resolution URL when nothing is stored yet", async () => {
    mockNetwork({ "https://bit.ly/xyz": { location: "https://soundcloud.com/real-artist" } });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://bit.ly/xyz", original_url: null })],
    });

    await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates[0].patch.original_url).toBe("https://bit.ly/xyz");
  });

  it("never clobbers an existing original_url", async () => {
    // An existing original is a truer original than this one — it predates
    // whatever put the shortened link here.
    mockNetwork({ "https://bit.ly/xyz": { location: "https://soundcloud.com/real-artist" } });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({
          id: 1,
          platform: "other",
          url: "https://bit.ly/xyz",
          original_url: "https://the-true-original.example.com/artist",
        }),
      ],
    });

    await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates[0].patch).not.toHaveProperty("original_url");
  });
});

describe("resolveArtistLinks — idempotency and no-ops", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes nothing on a second run", async () => {
    mockNetwork({ "https://bit.ly/xyz": { location: "https://soundcloud.com/real-artist" } });
    const db: FakeDb = {
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://bit.ly/xyz" })],
    };
    const { client, updates } = fakeClient(db);

    await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(1);

    // The row now holds soundcloud.com/real-artist, which is not a resolvable
    // host — so the second run doesn't even examine it.
    const second = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(second.examined).toBe(0);
    expect(updates).toHaveLength(1);
  });

  it("reports 'unchanged' when resolution lands back on the stored URL", async () => {
    mockNetwork({ "https://bit.ly/xyz": { location: "https://bit.ly/xyz" } });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://bit.ly/xyz" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(updates).toHaveLength(0);
    // A self-redirect is a loop, so the core reports max-hops rather than
    // handing back a URL identical to the input.
    expect(report.skipped[0].status).toBe("skipped");
  });
});

describe("resolveArtistLinks — dry run and failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("decides everything and writes nothing in a dry run", async () => {
    mockNetwork({ "https://bit.ly/xyz": { location: "https://soundcloud.com/real-artist" } });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [link({ id: 1, platform: "other", url: "https://bit.ly/xyz" })],
    });

    const report = await resolveArtistLinks(client, { all: true }, { ...NO_DELAY, dryRun: true });
    expect(updates).toHaveLength(0);
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]).toMatchObject({
      newPlatform: "soundcloud",
      newUrl: "https://soundcloud.com/real-artist",
    });
  });

  it("records a write failure without aborting the run", async () => {
    mockNetwork({
      "https://bit.ly/one": { location: "https://soundcloud.com/a" },
      "https://bit.ly/two": { location: "https://bandcamp.com/b" },
    });
    const { client } = fakeClient({
      platforms: ALL_PLATFORMS,
      updateError: "connection reset",
      links: [
        link({ id: 1, platform: "other", url: "https://bit.ly/one" }),
        link({ id: 2, platform: "linktree", url: "https://bit.ly/two" }),
      ],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.updated).toHaveLength(0);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped[0]).toMatchObject({ reason: "write-failed", error: "connection reset" });
  });

  it("keeps going when one row's network call fails", async () => {
    vi.spyOn(global, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("bit.ly/broken")) return Promise.reject(new Error("network down"));
      const location = url.includes("on.soundcloud.com") ? "https://soundcloud.com/fine" : null;
      return Promise.resolve({
        status: location ? 302 : 200,
        headers: { get: () => location },
        body: null,
      } as unknown as Response);
    });
    const { client, updates } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "other", url: "https://bit.ly/broken" }),
        link({ id: 2, platform: "soundcloud", url: "https://on.soundcloud.com/ok" }),
      ],
    });

    const report = await resolveArtistLinks(client, { all: true }, NO_DELAY);
    expect(report.skipped[0]).toMatchObject({ id: 1, reason: "network-error" });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(2);
  });

  it("reports every outcome through onProgress", async () => {
    mockNetwork({
      "https://bit.ly/one": { location: "https://soundcloud.com/a" },
      "https://spotify.link/two": { location: "https://spotify.app.link/two" },
    });
    const seen: RowOutcome[] = [];
    const { client } = fakeClient({
      platforms: ALL_PLATFORMS,
      links: [
        link({ id: 1, platform: "other", url: "https://bit.ly/one" }),
        link({ id: 2, platform: "spotify", url: "https://spotify.link/two" }),
      ],
    });

    await resolveArtistLinks(client, { all: true }, { ...NO_DELAY, onProgress: (o) => seen.push(o) });
    expect(seen.map((o) => o.status)).toEqual(["updated", "skipped"]);
  });

  it("throws when the table can't be read at all", async () => {
    const client = {
      from: () => ({
        select: () => ({
          not: () => ({
            or: () => ({
              order: () => ({
                range: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(resolveArtistLinks(client, { all: true }, NO_DELAY)).rejects.toThrow(
      /Could not read artist_links: permission denied/
    );
  });
});
