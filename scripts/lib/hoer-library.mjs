// ============================================================
// Pure, DB-free helpers for the HÖR library harvester
// (harvest-hoer-library.mjs — Phase A of the rework; see
// documentation/HOER-SYNC-REWORK-PLAN.md).
//
// Everything here is deterministic and side-effect-free so it can be
// unit-tested without a database or the network (see hoer-library.test.mjs).
// The script owns the Supabase reads/writes and the HÖR HTTP calls (via
// hoer-http.mjs); this module owns date/cursor arithmetic and the shaping of
// a WP REST post into a hoer_sets row. Same split as hoer-resolve.mjs.
// ============================================================

import { HOER_ORIGIN } from "./hoer-http.mjs";

// Default overlap window for an incremental run: from max(post_date) in the
// ledger, rewind this many days and re-crawl forward. Generous on purpose —
// it guarantees coverage across the boundary AND gives the modified_after
// sweep a week-wide window to catch sets that were tagged or re-credited
// after publication. At ~32 posts/week the extra reads are cheap.
export const DEFAULT_REWIND_DAYS = 7;

// ------------------------------------------------------------
// Date handling. WordPress publishes `date` / `modified` as naive local
// strings with no zone ("2026-07-22T19:00:31"), and the REST `after` /
// `modified_after` params expect the same shape. We keep everything in that
// naive space end to end and never attach a zone, so no driver applies an
// implicit conversion. Arithmetic treats the string as UTC purely as a
// stable clock for day subtraction — the offset cancels because we format
// straight back to the same naive shape.
// ------------------------------------------------------------

// Normalize any WP / PostgREST datetime string to naive "YYYY-MM-DDTHH:MM:SS":
// tolerate a space separator, a trailing "Z", and fractional seconds. Returns
// null for null/empty/unparseable input.
export function normalizeNaive(s) {
  if (s == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(s).trim());
  return m ? `${m[1]}T${m[2]}` : null;
}

// Subtract `days` from a naive datetime string, returning the same naive
// shape. Throws on unparseable input (callers only ever pass a value that
// came from normalizeNaive of a real DB row).
export function rewindNaive(naive, days) {
  const norm = normalizeNaive(naive);
  if (norm == null) throw new Error(`rewindNaive: unparseable date ${JSON.stringify(naive)}`);
  const d = new Date(`${norm}Z`); // treat as UTC — a stable clock, offset cancels
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"
}

// Parse a --from argument: an ISO date "2026-02-04" (→ midnight) or a fuller
// "2026-02-04T12:30" / "2026-02-04 12:30:00". Returns naive
// "YYYY-MM-DDTHH:MM:SS". Throws on anything that isn't a plausible date so a
// typo fails loudly instead of crawling from a garbage cursor.
export function parseFromArg(s) {
  const t = String(s ?? "").trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(t);
  if (dateOnly) return `${dateOnly[1]}T00:00:00`;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) throw new Error(`--from: not an ISO date: ${JSON.stringify(s)} (want YYYY-MM-DD)`);
  return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}`;
}

// Decide where an incremental / seeding crawl starts.
//
//   fromArg present            → crawl from that date (mode "from").
//   else maxPostDate present   → rewind `rewindDays` from it (mode "incremental").
//   else                       → throw: an empty ledger MUST be seeded with an
//                                explicit --from, never a silent full crawl of
//                                all ~9,500 posts.
//
// Returns { start, mode, rewindDays? }.
export function computeCrawlStart({ fromArg = null, rewindDays = DEFAULT_REWIND_DAYS, maxPostDate = null } = {}) {
  if (fromArg != null && String(fromArg).trim() !== "") {
    return { start: parseFromArg(fromArg), mode: "from" };
  }
  const max = normalizeNaive(maxPostDate);
  if (max != null) {
    return { start: rewindNaive(max, rewindDays), mode: "incremental", rewindDays };
  }
  throw new Error(
    "hoer_sets is empty and no --from was given. Seed the ledger with an " +
      "explicit start date, e.g. --from=2026-02-04. Refusing to crawl the " +
      "entire ~9,500-post archive by accident."
  );
}

// ------------------------------------------------------------
// Post → hoer_sets row shaping
// ------------------------------------------------------------

// A minimal HTML-entity decode for the stored `title` (a human-facing field).
// content/excerpt are stored as raw rendered HTML on purpose — they are bulk
// payload for later mining, where faithfulness beats prettiness.
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&#8217;|&rsquo;/gi, "’")
    .replace(/&#8216;|&lsquo;/gi, "‘")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function artistUrl(slug) {
  return `${HOER_ORIGIN}/artist/${slug}/`;
}

// Canonicalize a URL for comparison/storage: force https, lowercase host, drop
// the fragment, strip a single trailing slash. Used both to normalize a
// scraped social (Phase C) and to normalize an existing artist_links.url when
// matching against it (Phase D), so the two agree. Throws on an unparseable
// URL (callers guard).
export function normalizeUrl(url) {
  const u = new URL(String(url));
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

// Per-author artist page URLs, from the post's expanded `authors` array.
// Deduped, order-preserving; authors without a slug are skipped. Returns []
// when the array is absent (Phase B falls back to resolving term ids).
export function artistUrlsFromAuthors(authors) {
  const urls = [];
  const seen = new Set();
  for (const a of Array.isArray(authors) ? authors : []) {
    const slug = a?.slug ? String(a.slug).trim() : "";
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    urls.push(artistUrl(slug));
  }
  return urls;
}

// Shape a WP REST post (fetched with the _fields list Phase A requests) into a
// hoer_sets row. `processed_at` is decided by the caller against the existing
// ledger row (see reconcileProcessedAt), not here.
export function postToSetRow(post) {
  return {
    post_id: post.id,
    post_date: normalizeNaive(post.date),
    post_date_gmt: normalizeNaive(post.date_gmt),
    post_modified: normalizeNaive(post.modified),
    post_modified_gmt: normalizeNaive(post.modified_gmt),
    set_url: post.link ?? null,
    set_slug: post.slug ?? null,
    title: post.title?.rendered ? decodeEntities(post.title.rendered) : null,
    content: post.content?.rendered ?? null,
    excerpt: post.excerpt?.rendered ?? null,
    tag_ids: Array.isArray(post.tags) ? post.tags : [],
    term_ids: Array.isArray(post.ppma_author) ? post.ppma_author : [],
    authors: Array.isArray(post.authors) ? post.authors : null,
    artist_urls: artistUrlsFromAuthors(post.authors),
  };
}

// Decide a row's processed_at against the ledger's existing value:
//
//   new post (no existing row)      → null   (Phase B must consume it)
//   post_modified changed           → null   (re-read; Phase B re-examines it)
//   post_modified unchanged         → keep the existing processed_at
//
// This is what makes the deliberate rewind idempotent: re-reading an
// unchanged set does not reset its processed flag, so Phase B's genre/collab
// writes for it are not replayed. `existing` is { post_modified, processed_at }
// or undefined.
export function reconcileProcessedAt(row, existing) {
  if (!existing) return null;
  const before = normalizeNaive(existing.post_modified);
  const after = normalizeNaive(row.post_modified);
  if (before !== after) return null;
  return existing.processed_at ?? null;
}
