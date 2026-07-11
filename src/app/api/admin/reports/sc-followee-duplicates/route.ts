import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { buildOds, type Cell } from "@/lib/ods";

export const dynamic = "force-dynamic";

// Absolute origin used to build links to each artist's edit page. Matches the
// convention in src/lib/email.ts / layout.tsx / the harvest-failures report.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://rebalance-gender.app";

// PostgREST caps a single select at ~1000 rows, so page through with .range()
// to guarantee we see every row regardless of table size.
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
  payload: { permalink_url?: string | null } | null;
}

interface ArtistLinkRow {
  artist_id: string;
  platform: string;
  url: string | null;
}

interface QueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Page through a PostgREST query with .range() until a short page ends it.
 *  Accepts a PromiseLike rather than Promise since a PostgrestFilterBuilder
 *  (the un-awaited return of e.g. admin.from(...).select(...).range(...)) is
 *  thenable but not a full Promise. */
async function fetchAllPages<T>(
  query: (from: number, to: number) => PromiseLike<QueryResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await query(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
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
 * (namespace='soundcloud_user', cache_key=artist_id, payload->>permalink_url)
 * rather than artist_enrichment.raw_data — that column was dropped by
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
      fetchAllPages<ArtistRow>((from, to) =>
        admin
          .from("artists")
          .select("id, name")
          .eq("directory_status", "sc_followee")
          .eq("deleted", false)
          .range(from, to),
      ),
      fetchAllPages<ArtistRow>((from, to) =>
        admin
          .from("artists")
          .select("id, name")
          .eq("directory_status", "approved")
          .eq("deleted", false)
          .range(from, to),
      ),
      fetchAllPages<CacheRow>((from, to) =>
        admin
          .from("api_response_cache")
          .select("cache_key, payload")
          .eq("namespace", "soundcloud_user")
          .range(from, to),
      ),
      fetchAllPages<ArtistLinkRow>((from, to) =>
        admin
          .from("artist_links")
          .select("artist_id, platform, url")
          .eq("not_found", false) // exclude url-less tombstone rows
          .range(from, to),
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
    const permalink = row.payload?.permalink_url;
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
