import { describe, it, expect } from "vitest";
import {
  DEFAULT_REWIND_DAYS,
  normalizeNaive,
  rewindNaive,
  parseFromArg,
  computeCrawlStart,
  decodeEntities,
  artistUrl,
  artistUrlsFromAuthors,
  postToSetRow,
  reconcileProcessedAt,
} from "./hoer-library.mjs";

describe("normalizeNaive", () => {
  it("passes through the canonical naive shape", () => {
    expect(normalizeNaive("2026-07-22T19:00:31")).toBe("2026-07-22T19:00:31");
  });
  it("tolerates a space separator, trailing Z, and fractional seconds", () => {
    expect(normalizeNaive("2026-07-22 19:00:31")).toBe("2026-07-22T19:00:31");
    expect(normalizeNaive("2026-07-22T19:00:31Z")).toBe("2026-07-22T19:00:31");
    expect(normalizeNaive("2026-07-22T19:00:31.000")).toBe("2026-07-22T19:00:31");
    expect(normalizeNaive("2026-07-22T19:00:31.512345+00:00")).toBe("2026-07-22T19:00:31");
  });
  it("returns null for null/empty/garbage", () => {
    expect(normalizeNaive(null)).toBeNull();
    expect(normalizeNaive("")).toBeNull();
    expect(normalizeNaive("not a date")).toBeNull();
  });
});

describe("rewindNaive", () => {
  it("subtracts whole days, keeping the naive shape and the clock time", () => {
    expect(rewindNaive("2026-07-22T19:00:31", 7)).toBe("2026-07-15T19:00:31");
  });
  it("crosses month and year boundaries", () => {
    expect(rewindNaive("2026-03-03T00:00:00", 7)).toBe("2026-02-24T00:00:00");
    expect(rewindNaive("2026-01-02T12:00:00", 7)).toBe("2025-12-26T12:00:00");
  });
  it("handles a leap-year February", () => {
    expect(rewindNaive("2028-03-01T06:30:00", 1)).toBe("2028-02-29T06:30:00");
  });
  it("throws on unparseable input", () => {
    expect(() => rewindNaive("nope", 7)).toThrow();
  });
});

describe("parseFromArg", () => {
  it("expands a bare date to midnight", () => {
    expect(parseFromArg("2026-02-04")).toBe("2026-02-04T00:00:00");
  });
  it("accepts fuller forms and fills missing seconds", () => {
    expect(parseFromArg("2026-02-04T12:30")).toBe("2026-02-04T12:30:00");
    expect(parseFromArg("2026-02-04 12:30:45")).toBe("2026-02-04T12:30:45");
  });
  it("throws on a non-date so a typo fails loudly", () => {
    expect(() => parseFromArg("last tuesday")).toThrow();
    expect(() => parseFromArg("2026/02/04")).toThrow();
    expect(() => parseFromArg("")).toThrow();
  });
});

describe("computeCrawlStart", () => {
  it("uses --from verbatim when given (mode from), ignoring maxPostDate", () => {
    expect(
      computeCrawlStart({ fromArg: "2026-02-04", maxPostDate: "2026-07-22T19:00:31" })
    ).toEqual({ start: "2026-02-04T00:00:00", mode: "from" });
  });
  it("rewinds the default window from maxPostDate when no --from", () => {
    expect(computeCrawlStart({ maxPostDate: "2026-07-22T19:00:31" })).toEqual({
      start: "2026-07-15T19:00:31",
      mode: "incremental",
      rewindDays: DEFAULT_REWIND_DAYS,
    });
  });
  it("honours a custom rewindDays", () => {
    expect(
      computeCrawlStart({ maxPostDate: "2026-07-22T19:00:31", rewindDays: 30 })
    ).toEqual({ start: "2026-06-22T19:00:31", mode: "incremental", rewindDays: 30 });
  });
  it("treats a blank --from as absent", () => {
    expect(computeCrawlStart({ fromArg: "   ", maxPostDate: "2026-07-22T19:00:31" }).mode).toBe(
      "incremental"
    );
  });
  it("throws on an empty ledger with no --from rather than crawling everything", () => {
    expect(() => computeCrawlStart({})).toThrow(/empty/i);
    expect(() => computeCrawlStart({ maxPostDate: null })).toThrow(/--from/);
  });
});

describe("decodeEntities", () => {
  it("decodes the entities that appear in HÖR titles", () => {
    expect(decodeEntities("POSI FLO | H&#xd6;R &#8211; July 22 / 2026")).toBe(
      "POSI FLO | HÖR – July 22 / 2026"
    );
    expect(decodeEntities("Rock &amp; Roll")).toBe("Rock & Roll");
  });
});

describe("artistUrlsFromAuthors", () => {
  it("builds one canonical URL per author, order-preserving", () => {
    expect(
      artistUrlsFromAuthors([{ slug: "gmoz" }, { slug: "posi-flo-2" }])
    ).toEqual([artistUrl("gmoz"), artistUrl("posi-flo-2")]);
  });
  it("dedupes and skips slugless authors", () => {
    expect(
      artistUrlsFromAuthors([{ slug: "a" }, { slug: "a" }, { display_name: "no slug" }])
    ).toEqual([artistUrl("a")]);
  });
  it("returns [] when authors is absent", () => {
    expect(artistUrlsFromAuthors(undefined)).toEqual([]);
    expect(artistUrlsFromAuthors(null)).toEqual([]);
  });
});

describe("postToSetRow", () => {
  const post = {
    id: 393357,
    date: "2026-07-22T19:00:31",
    date_gmt: "2026-07-22T17:00:31",
    modified: "2026-07-22T20:11:23",
    modified_gmt: "2026-07-22T18:11:23",
    link: "https://hoer.live/posi-flo-hor-july-22-2026/",
    slug: "posi-flo-hor-july-22-2026",
    title: { rendered: "POSI FLO | H&#xd6;R &#8211; July 22 / 2026" },
    content: { rendered: "<p>set notes</p>" },
    excerpt: { rendered: "<p>short</p>" },
    tags: [12, 34],
    ppma_author: [12361],
    authors: [{ term_id: 12361, slug: "posi-flo-2", display_name: "Posi Flo" }],
  };

  it("maps every field, decoding the title and keeping content raw", () => {
    expect(postToSetRow(post)).toEqual({
      post_id: 393357,
      post_date: "2026-07-22T19:00:31",
      post_date_gmt: "2026-07-22T17:00:31",
      post_modified: "2026-07-22T20:11:23",
      post_modified_gmt: "2026-07-22T18:11:23",
      set_url: "https://hoer.live/posi-flo-hor-july-22-2026/",
      set_slug: "posi-flo-hor-july-22-2026",
      title: "POSI FLO | HÖR – July 22 / 2026",
      content: "<p>set notes</p>",
      excerpt: "<p>short</p>",
      tag_ids: [12, 34],
      term_ids: [12361],
      authors: [{ term_id: 12361, slug: "posi-flo-2", display_name: "Posi Flo" }],
      artist_urls: [artistUrl("posi-flo-2")],
    });
  });

  it("defaults arrays and nulls when a set is untagged / author-less", () => {
    const bare = { id: 1, date: "2026-01-01T00:00:00" };
    const row = postToSetRow(bare);
    expect(row.tag_ids).toEqual([]);
    expect(row.term_ids).toEqual([]);
    expect(row.authors).toBeNull();
    expect(row.artist_urls).toEqual([]);
    expect(row.title).toBeNull();
    expect(row.content).toBeNull();
  });
});

describe("reconcileProcessedAt", () => {
  const row = { post_modified: "2026-07-22T20:11:23" };

  it("is null for a brand-new post", () => {
    expect(reconcileProcessedAt(row, undefined)).toBeNull();
  });
  it("resets to null when post_modified changed", () => {
    const existing = { post_modified: "2026-07-22T19:00:00", processed_at: "2026-07-22T21:00:00Z" };
    expect(reconcileProcessedAt(row, existing)).toBeNull();
  });
  it("keeps the existing processed_at when unchanged (idempotent re-read)", () => {
    const existing = { post_modified: "2026-07-22T20:11:23", processed_at: "2026-07-22T21:00:00Z" };
    expect(reconcileProcessedAt(row, existing)).toBe("2026-07-22T21:00:00Z");
  });
  it("compares modified times through normalization (Z / fractional don't count as a change)", () => {
    const existing = {
      post_modified: "2026-07-22T20:11:23.000Z",
      processed_at: "2026-07-22T21:00:00Z",
    };
    expect(reconcileProcessedAt(row, existing)).toBe("2026-07-22T21:00:00Z");
  });
  it("stays null when unchanged but never processed", () => {
    const existing = { post_modified: "2026-07-22T20:11:23", processed_at: null };
    expect(reconcileProcessedAt(row, existing)).toBeNull();
  });
});
