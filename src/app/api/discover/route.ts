import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";

const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a Last.fm URL so it can be compared against artist_links.url */
function normalizeLfmUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * Extract a human-readable artist name from whatever the user typed.
 * Handles Last.fm URLs and SoundCloud URLs; falls through to raw text.
 */
function extractArtistName(query: string): string {
  const q = query.trim();

  // https://www.last.fm/music/Artist+Name or .../Artist+Name/...
  const lfm = q.match(/last\.fm\/music\/([^/?#]+)/i);
  if (lfm) return decodeURIComponent(lfm[1]).replace(/\+/g, " ");

  // https://soundcloud.com/username — use the slug as a name and let LFM
  // autocorrect do its best
  const sc = q.match(/soundcloud\.com\/([^/?#]+)/i);
  if (sc) return sc[1].replace(/-/g, " ");

  return q;
}

interface LfmSimilarArtist {
  name: string;
  match: string;
  mbid: string;
  url: string;
}

interface LfmSimilarResponse {
  similarartists?: {
    artist?: LfmSimilarArtist | LfmSimilarArtist[];
    "@attr"?: { artist?: string };
  };
}

interface LfmTopTagsResponse {
  toptags?: {
    tag?: { name: string; count?: number }[];
  };
}

async function lfmGet<T>(
  method: string,
  params: Record<string, string>
): Promise<T> {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is not set");

  const url = new URL(LASTFM_BASE);
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const r = await fetch(url.toString(), { next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`Last.fm HTTP ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(`Last.fm: ${data.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoverResult {
  id: string;
  name: string;
  profile_image_url: string | null;
  score: number;
}

export interface DiscoverResponse {
  resolvedName: string;
  results: DiscoverResult[];
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const query: string = body.query?.trim() ?? "";

  if (!query) {
    return NextResponse.json({ error: "No query provided" }, { status: 400 });
  }

  const artistName = extractArtistName(query);
  const supabase = getSupabaseClient();

  // 1. Check for pre-computed similarity scores before hitting Last.fm.
  //    artist_similarity_scores is pre-computed for every artist in the DB
  //    (including non-directory ones added from prior cold-start searches),
  //    so repeat queries are instant lookups.
  const { data: dbArtist } = await supabase
    .from("artists")
    .select("id")
    .ilike("name", artistName)
    .eq("deleted", false)
    .maybeSingle();

  if (dbArtist) {
    const { data: scoreRows } = await supabase
      .from("artist_similarity_scores")
      .select(`
        total_score,
        recommended:artists!recommended_artist_id(
          id,
          name,
          profile_image_url,
          enrichment:artist_enrichment(profile_image_url)
        )
      `)
      .eq("source_artist_id", dbArtist.id)
      .order("rank")
      .limit(10);

    if (scoreRows && scoreRows.length > 0) {
      type ScoreRow = {
        total_score: number;
        recommended: {
          id: string;
          name: string;
          profile_image_url: string | null;
          enrichment: { profile_image_url: string | null }[] | null;
        } | null;
      };

      const results: DiscoverResult[] = (scoreRows as unknown as ScoreRow[])
        .map((row) => {
          const a = row.recommended;
          if (!a) return null;
          const enrichmentImage =
            a.enrichment?.find((e) => e.profile_image_url)?.profile_image_url ?? null;
          return {
            id: a.id,
            name: a.name,
            profile_image_url: a.profile_image_url ?? enrichmentImage ?? null,
            score: row.total_score,
          };
        })
        .filter((r): r is DiscoverResult => r !== null);

      return NextResponse.json({ resolvedName: artistName, results } satisfies DiscoverResponse);
    }
  }

  // No pre-computed scores found — fall back to a live Last.fm lookup.
  try {
    // 1. Fetch LFM similar artists and top tags in parallel
    const [similarData, tagsData] = await Promise.all([
      lfmGet<LfmSimilarResponse>("artist.getSimilar", {
        artist: artistName,
        limit: "100",
        autocorrect: "1",
      }),
      lfmGet<LfmTopTagsResponse>("artist.getTopTags", {
        artist: artistName,
        autocorrect: "1",
      }),
    ]);

    // LFM returns the corrected name in the @attr block
    const resolvedName: string =
      similarData?.similarartists?.["@attr"]?.artist ?? artistName;

    // Normalize to array (LFM returns an object when there's only one result)
    const raw = similarData?.similarartists?.artist;
    const lfmSimilar: Array<{
      name: string;
      match: string;
      mbid: string;
      url: string;
    }> = Array.isArray(raw) ? raw : raw ? [raw] : [];

    const topTags: string[] = (tagsData?.toptags?.tag ?? [])
      .slice(0, 15)
      .map((t) => t.name.toLowerCase());

    // Build quick-lookup maps from LFM similar list
    const lfmByUrl = new Map<string, number>(); // normalized URL → match score
    const lfmByName = new Map<string, number>(); // lowercase name → match score
    for (const s of lfmSimilar) {
      const score = parseFloat(s.match);
      lfmByUrl.set(normalizeLfmUrl(s.url), score);
      lfmByName.set(s.name.toLowerCase(), score);
    }

    // 2. Match LFM similar against directory artists' Last.fm links
    const { data: lfmLinks } = await supabase
      .from("artist_links")
      .select("artist_id, url")
      .eq("platform", "lastfm");

    const lfmScores = new Map<string, number>(); // artist_id → score
    for (const link of lfmLinks ?? []) {
      const score = lfmByUrl.get(normalizeLfmUrl(link.url));
      if (score !== undefined) lfmScores.set(link.artist_id, score);
    }

    // 3. Name-based fallback for directory artists without a Last.fm link
    const { data: allArtists } = await supabase
      .from("artists")
      .select("id, name, profile_image_url")
      .eq("directory_status", "approved")
      .eq("deleted", false);

    const artistById = new Map<string, { id: string; name: string; profile_image_url: string | null }>();
    for (const a of allArtists ?? []) {
      artistById.set(a.id, a);
      if (!lfmScores.has(a.id)) {
        const score = lfmByName.get(a.name.toLowerCase());
        if (score !== undefined) {
          // Slight discount for name-only matches (no confirmed LFM link)
          lfmScores.set(a.id, score * 0.75);
        }
      }
    }

    // 4. Genre overlap — find directory artists sharing the queried artist's LFM tags
    const genreScores = new Map<string, number>(); // artist_id → overlap score

    if (topTags.length > 0) {
      // Resolve LFM tag names to our genre IDs (case-insensitive)
      const { data: allGenres } = await supabase
        .from("genres")
        .select("id, name");

      const matchingGenreIds = (allGenres ?? [])
        .filter((g) => topTags.includes(g.name.toLowerCase()))
        .map((g) => g.id);

      if (matchingGenreIds.length > 0) {
        const { data: artistGenreRows } = await supabase
          .from("artist_genres")
          .select("artist_id, genre_id")
          .in("genre_id", matchingGenreIds);

        for (const row of artistGenreRows ?? []) {
          genreScores.set(
            row.artist_id,
            (genreScores.get(row.artist_id) ?? 0) + 1
          );
        }
        // Normalize genre score to [0, 1]
        for (const [id, count] of genreScores.entries()) {
          genreScores.set(id, count / Math.min(topTags.length, matchingGenreIds.length));
        }
      }
    }

    // 5. Combine all candidate artist IDs
    const candidates = new Set([
      ...lfmScores.keys(),
      ...genreScores.keys(),
    ]);

    if (candidates.size === 0) {
      return NextResponse.json({ resolvedName, results: [] } satisfies DiscoverResponse);
    }

    // 6. Fetch enrichment images for candidates
    const candidateIds = Array.from(candidates);
    const { data: enrichmentRows } = await supabase
      .from("artist_enrichment")
      .select("artist_id, profile_image_url")
      .in("artist_id", candidateIds)
      .not("profile_image_url", "is", null);

    const enrichmentImageById = new Map<string, string>();
    for (const row of enrichmentRows ?? []) {
      if (row.profile_image_url)
        enrichmentImageById.set(row.artist_id, row.profile_image_url);
    }

    // 7. Score, rank, and return top 10
    // Weights: LFM similar score is primary (80%), genre overlap secondary (20%)
    const results: DiscoverResult[] = candidateIds
      .map((id) => {
        const lfm = lfmScores.get(id) ?? 0;
        const genre = genreScores.get(id) ?? 0;
        const score = lfm * 0.8 + genre * 0.2;
        const artist = artistById.get(id);
        if (!artist) return null;
        return {
          id,
          name: artist.name,
          profile_image_url:
            artist.profile_image_url ??
            enrichmentImageById.get(id) ??
            null,
          score,
        };
      })
      .filter((r): r is DiscoverResult => r !== null && r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return NextResponse.json({ resolvedName, results } satisfies DiscoverResponse);
  } catch (err) {
    console.error("discover error:", err);
    const message: string = err instanceof Error ? err.message : "Something went wrong";
    const isNotFound = message.toLowerCase().includes("not found") ||
      message.toLowerCase().includes("no artist");
    return NextResponse.json(
      { error: isNotFound ? `Artist "${artistName}" not found on Last.fm` : message },
      { status: isNotFound ? 404 : 500 }
    );
  }
}
