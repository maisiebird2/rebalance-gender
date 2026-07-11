import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { buildOds, type Cell } from "@/lib/ods";

export const dynamic = "force-dynamic";
// This report pages through ~133k sc_followee artists and ~135k soundcloud_user
// cache rows, which exceeds Vercel's default function budget (10s on Hobby).
// 60s is the Hobby ceiling; raise to it. Every page is now a fast 1000-row read
// of small columns (no JSONB detoast — see the permalink_url generated column;
// artist_links is filtered to approved-owned rows server-side), so the wall
// clock is just the ~135 sequential keyset round-trips of the two big streams,
// run in parallel. Measured ~33s from a remote client on a slow link (latency-
// bound); from Vercel, co-located with the DB, it is a few seconds — inside 60s
// either way. This export just lifts the default so the platform doesn't cut
// the request short.
export const maxDuration = 60;

// Absolute origin used to build links to each artist's edit page. Matches the
// convention in src/lib/email.ts / layout.tsx / the harvest-failures report.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://rebalance-gender.app";

// PostgREST caps a single select at ~1000 rows, so page through to guarantee
// we see every row regardless of table size. We use *keyset* pagination
// (ORDER BY <unique key>, then WHERE key > lastSeen) rather than LIMIT/OFFSET:
// OFFSET pages re-scan and discard everything before the window, so deep pages
// on a large table (notably api_response_cache) get progressively slower and
// eventually trip Postgres' statement_timeout. Keyset pages stay index-fast at
// any depth, and the explicit ORDER BY also makes paging stable (OFFSET paging
// with no ORDER BY can silently skip or duplicate rows).
const PAGE_SIZE = 1000;

/**
 * Normalize a profile URL for exact-match comparison: lowercase, strip the
 * scheme and a leading "www.", drop the query/fragment, and strip a trailing
 * slash. Same approach as canonicalizeUrl() in lib/submission-helpers.ts —
 * kept local here since this report only needs it for one field.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

interface ArtistRow {
  id: string;
  name: string;
}

interface CacheRow {
  cache_key: string; // artist_id as text
  // Generated column materializing payload->>'permalink_url' (see the migration
  // supabase_migration_cache_permalink_url.sql) so reading it never detoasts the
  // large SoundCloud user JSONB for every cached row.
  permalink_url: string | null;
}

interface ArtistLinkRow {
  id: number; // keyset cursor column
  artist_id: string;
  platform: string;
  url: string | null;
}

interface QueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Keyset-paginate a PostgREST query until a short page ends it. `page` must
 *  ORDER BY a unique column, `.limit(PAGE_SIZE)`, and (when given a cursor)
 *  filter `key > cursor`; `cursorOf` reads that key off the last row of a page.
 *
 *  Accepts a PromiseLike rather than Promise since a PostgrestFilterBuilder
 *  (the un-awaited return of e.g. admin.from(...).select(...).limit(...)) is
 *  thenable but not a full Promise. */
async function fetchAllPages<T>(
  cursorOf: (row: T) => string | number,
  page: (afterCursor: string | number | null) => PromiseLike<QueryResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | number | null = null;
  for (;;) {
    const { data, error } = await page(cursor);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    cursor = cursorOf(batch[batch.length - 1]);
  }
  return rows;
}

interface DuplicateRow {
  followeeId: string;
  followeeName: string;
  followeeUrl: string;
  approvedId: string;
  approvedName: string;
  approvedPlatform: string;
  approvedUrl: string;
}

/**
 * GET /api/admin/reports/sc-followee-duplicates
 *
 * Auth-guarded admin report. Finds `sc_followee` artists whose SoundCloud
 * profile URL matches a URL already held by an `approved` artist (any
 * platform, via artist_links).
 *
 * The SoundCloud permalink comes from api_response_cache
 * (namespace='soundcloud_user', cache_key=artist_id, permalink_url — a
 * generated column materializing payload->>'permalink_url', see
 * supabase_migration_cache_permalink_url.sql) rather than
 * artist_enrichment.raw_data — that column was dropped by
 * supabase_migration_move_raw_data_to_cache.sql, which moved the raw
 * per-artist API payloads into the cache table (see scripts/MATCHING.md /
 * scripts/find-sc-followee-duplicates.sql, the raw-SQL version of this
 * report, for the same lookup).
 *
 * This intentionally does the join/normalize/match in JS rather than in a
 * single SQL query: an earlier version of this as a raw SQL query (regex
 * URL-normalization on both sides, joined server-side) hit an upstream
 * timeout in the Supabase SQL editor. Paginating simple filtered selects and
 * matching in memory — the same approach scripts/find-duplicates.mjs already
 * uses for its URL-exact signal — avoids that.
 */
export async function GET() {
  // ── Auth guard (same pattern as the rest of /admin) ────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdminClient();

  let followees: ArtistRow[];
  let approvedArtists: ArtistRow[];
  let cacheRows: CacheRow[];
  let linkRows: ArtistLinkRow[];

  try {
    [followees, approvedArtists, cacheRows, linkRows] = await Promise.all([
      fetchAllPages<ArtistRow>(
        (r) => r.id,
        (after) => {
          let q = admin
            .from("artists")
            .select("id, name")
            .eq("directory_status", "sc_followee")
            .eq("deleted", false)
            .order("id")
            .limit(PAGE_SIZE);
          if (after !== null) q = q.gt("id", after);
          return q;
        },
      ),
      fetchAllPages<ArtistRow>(
        (r) => r.id,
        (after) => {
          let q = admin
            .from("artists")
            .select("id, name")
            .eq("directory_status", "approved")
            .eq("deleted", false)
            .order("id")
            .limit(PAGE_SIZE);
          if (after !== null) q = q.gt("id", after);
          return q;
        },
      ),
      fetchAllPages<CacheRow>(
        (r) => r.cache_key,
        (after) => {
          // Read the generated permalink_url column instead of the whole
          // `payload` JSONB (or payload->>permalink_url, which still detoasts
          // it): the SoundCloud user objects are large, and detoasting one per
          // row was the report's dominant cost. See
          // supabase_migration_cache_permalink_url.sql. cache_key is the
          // trailing half of the (namespace, cache_key) PK, so ordering by it
          // within the fixed namespace is index-backed.
          let q = admin
            .from("api_response_cache")
            .select("cache_key, permalink_url")
            .eq("namespace", "soundcloud_user")
            .order("cache_key")
            .limit(PAGE_SIZE);
          if (after !== null) q = q.gt("cache_key", after);
          return q;
        },
      ),
      fetchAllPages<ArtistLinkRow>(
        (r) => r.id,
        (after) => {
          // Only approved artists' links are ever used (to build approvedByUrl
          // below), so filter to them server-side via an inner join on the
          // artist_links -> artists FK. That drops this from ~199k rows / ~199
          // pages to ~10k / ~10, making it no longer the long pole. The nested
          // `artists` object the embed returns is unused.
          let q = admin
            .from("artist_links")
            .select("id, artist_id, platform, url, artists!inner(directory_status)")
            .eq("artists.directory_status", "approved")
            .eq("not_found", false) // exclude url-less tombstone rows
            .order("id")
            .limit(PAGE_SIZE);
          if (after !== null) q = q.gt("id", after);
          return q;
        },
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Query failed";
    console.error("sc-followee-duplicates report query:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const followeeNameById = new Map(followees.map((a) => [a.id, a.name]));
  const followeeIds = new Set(followees.map((a) => a.id));
  const approvedNameById = new Map(approvedArtists.map((a) => [a.id, a.name]));
  const approvedIds = new Set(approvedArtists.map((a) => a.id));

  // normalized URL -> approved links sharing it (an approved artist could in
  // principle have more than one link that normalizes to the same URL).
  const approvedByUrl = new Map<
    string,
    { artistId: string; platform: string; url: string }[]
  >();
  for (const link of linkRows) {
    if (!link.url || !approvedIds.has(link.artist_id)) continue;
    const norm = normalizeUrl(link.url);
    if (!approvedByUrl.has(norm)) approvedByUrl.set(norm, []);
    approvedByUrl.get(norm)!.push({
      artistId: link.artist_id,
      platform: link.platform,
      url: link.url,
    });
  }

  const duplicates: DuplicateRow[] = [];
  for (const row of cacheRows) {
    const artistId = row.cache_key;
    if (!followeeIds.has(artistId)) continue;
    const permalink = row.permalink_url;
    if (!permalink) continue;

    const matches = approvedByUrl.get(normalizeUrl(permalink));
    if (!matches?.length) continue;

    const followeeName = followeeNameById.get(artistId) ?? "(unknown)";
    for (const match of matches) {
      duplicates.push({
        followeeId: artistId,
        followeeName,
        followeeUrl: permalink,
        approvedId: match.artistId,
        approvedName: approvedNameById.get(match.artistId) ?? "(unknown)",
        approvedPlatform: match.platform,
        approvedUrl: match.url,
      });
    }
  }

  duplicates.sort((a, b) => a.followeeName.localeCompare(b.followeeName));

  const headers = [
    "SC followee",
    "SoundCloud URL",
    "Approved artist",
    "Platform",
    "Approved URL",
  ];

  const dataRows: Cell[][] = duplicates.map((d) => [
    { text: d.followeeName, href: `${SITE_URL}/artist/${d.followeeId}/edit` },
    d.followeeUrl,
    { text: d.approvedName, href: `${SITE_URL}/artist/${d.approvedId}/edit` },
    d.approvedPlatform,
    d.approvedUrl,
  ]);

  const ods = buildOds({
    name: "SC followee duplicates",
    headers,
    rows: dataRows,
  });

  const date = new Date().toISOString().slice(0, 10);
  const filename = `sc-followee-duplicates-${date}.ods`;

  return new NextResponse(new Uint8Array(ods), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.oasis.opendocument.spreadsheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(ods.length),
      "Cache-Control": "no-store",
    },
  });
}
