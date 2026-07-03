import { getSupabaseClient } from "./supabase";
import type {
  ArtistPage,
  ArtistWithRelations,
  DirectoryFilters,
} from "./types";

export const PAGE_SIZE = 24;

/**
 * Normalizes a search string to match the `name_search` generated column:
 * strips accents (NFD decompose + remove combining marks), lowercases,
 * and removes spaces. Must stay in sync with the Postgres expression:
 *   lower(replace(unaccent(name), ' ', ''))
 */
function normalizeSearch(s: string): string {
  // NFD decomposes e.g. "é" into "e" + combining acute; the regex then
  // strips all combining diacritical marks (U+0300-U+036F).
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

// Shared select string: pulls the artist plus all joined relations
// (pronoun, genres via the artist_genres junction table, locations,
// links, and cached enrichment data).
const ARTIST_SELECT = `
  *,
  pronoun:pronouns(*),
  artist_genres(genres(*)),
  locations:artist_locations(*),
  label_list:artist_labels(*),
  aliases:artist_aliases(*),
  links:artist_links(*),
  enrichment:artist_enrichment(*),
  bandcamp_albums:artist_bandcamp_albums(*)
`;

// Flatten the nested artist_genres(genres(*)) shape into a plain
// genres[] array on each artist for easier use in components.
function normalizeArtist(row: any): ArtistWithRelations {
  const genres = (row.artist_genres ?? [])
    .map((ag: any) => ag.genres)
    .filter((g: any) => g?.status === "approved");

  return {
    ...row,
    genres,
  };
}

/**
 * Fetch one page of approved artists, optionally filtered by genre,
 * country, and a free-text search over the artist name.
 *
 * Genre/country filters use `!inner` joins so that only artists with a
 * matching related row are returned. Results are paginated using
 * `PAGE_SIZE`; `filters.page` is 1-indexed (defaults to 1).
 */
export async function getArtists(
  filters: DirectoryFilters = {}
): Promise<ArtistPage> {
  const supabase = getSupabaseClient();

  let select = ARTIST_SELECT;
  if (filters.genre) {
    select = select.replace(
      "artist_genres(genres(*))",
      "artist_genres!inner(genres!inner(*))"
    );
  }
  if (filters.country) {
    select = select.replace(
      "locations:artist_locations(*)",
      "locations:artist_locations!inner(*)"
    );
  }

  let query = supabase
    .from("artists")
    .select(select)
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .order("name");

  if (filters.genre) {
    query = query.eq("artist_genres.genres.name", filters.genre);
  }
  if (filters.country) {
    query = query.eq("locations.country", filters.country);
  }
  if (filters.search) {
    query = query.ilike("name_search", `%${normalizeSearch(filters.search)}%`);
  }

  // Fetch one extra row beyond the page: its presence tells us a next
  // page exists, without the cost of an exact COUNT over all matches.
  const page = Math.max(1, filters.page ?? 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE; // inclusive → PAGE_SIZE + 1 rows
  query = query.range(from, to);

  const { data, error } = await query;

  if (error) {
    console.error("getArtists error:", error);
    return { artists: [], hasMore: false };
  }

  const rows = data ?? [];
  const hasMore = rows.length > PAGE_SIZE;

  return {
    artists: rows.slice(0, PAGE_SIZE).map(normalizeArtist),
    hasMore,
  };
}

/**
 * Fetch one page of approved artists that have NO artist_links row for the
 * given platform — used by the admin "Missing links" page. An artist with a
 * `not_found: true` row for the platform is NOT considered missing (someone
 * already searched and concluded the artist isn't on that platform).
 *
 * Implemented as a PostgREST anti-join: embed artist_links filtered to the
 * platform, then keep only rows where that (filtered) embed is empty.
 */
export async function getArtistsMissingLink(
  platform: string,
  page: number = 1
): Promise<ArtistPage> {
  const supabase = getSupabaseClient();

  // Second embed of artist_links under its own alias, used only for the
  // anti-join filter; ARTIST_SELECT's `links` embed stays unfiltered.
  const select = `${ARTIST_SELECT}, link_check:artist_links(platform)`;

  const from = (Math.max(1, page) - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE; // one extra row → hasMore

  const { data, error } = await supabase
    .from("artists")
    .select(select)
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .eq("link_check.platform", platform)
    .is("link_check", null)
    .order("name")
    .range(from, to);

  if (error) {
    console.error("getArtistsMissingLink error:", error);
    return { artists: [], hasMore: false };
  }

  const rows = data ?? [];
  return {
    artists: rows.slice(0, PAGE_SIZE).map(normalizeArtist),
    hasMore: rows.length > PAGE_SIZE,
  };
}

/** Fetch a single approved artist (with all relations) by id, for the detail page. */
export async function getArtistById(
  id: string
): Promise<ArtistWithRelations | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("artists")
    .select(ARTIST_SELECT)
    .eq("id", id)
    .eq("directory_status", "approved")
    .eq("deleted", false)
    .maybeSingle();

  if (error) {
    console.error("getArtistById error:", error);
    return null;
  }
  if (!data) return null;

  return normalizeArtist(data);
}

/**
 * Fetch a randomly-ordered page of approved artists (no filters applied).
 * Uses two queries: first fetch all approved IDs (lightweight), shuffle
 * server-side with Fisher-Yates, then fetch the page slice by ID.
 * Each request produces a different random order — good for discovery.
 */
export async function getRandomArtists(page: number = 1): Promise<ArtistPage> {
  const supabase = getSupabaseClient();

  // 1. Fetch all approved IDs (just UUIDs, very lightweight)
  const { data: idRows, error: idError } = await supabase
    .from("artists")
    .select("id")
    .eq("directory_status", "approved")
    .eq("deleted", false);

  if (idError || !idRows) {
    console.error("getRandomArtists id error:", idError);
    return { artists: [], hasMore: false };
  }

  // 2. Fisher-Yates shuffle
  const ids = idRows.map((r: { id: string }) => r.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }

  // 3. Slice for the requested page; we already have every ID, so
  // "more pages exist" is a simple length check.
  const from = (Math.max(1, page) - 1) * PAGE_SIZE;
  const pageIds = ids.slice(from, from + PAGE_SIZE);
  const hasMore = from + PAGE_SIZE < ids.length;
  if (pageIds.length === 0) return { artists: [], hasMore: false };

  // 4. Fetch full records for this page's IDs
  const { data, error } = await supabase
    .from("artists")
    .select(ARTIST_SELECT)
    .in("id", pageIds)
    .eq("directory_status", "approved")
    .eq("deleted", false);

  if (error) {
    console.error("getRandomArtists fetch error:", error);
    return { artists: [], hasMore: false };
  }

  // 5. Re-order to match the shuffled ID order (DB returns arbitrary order)
  const byId = new Map((data ?? []).map((a: any) => [a.id, a]));
  const ordered = pageIds
    .map((id) => byId.get(id))
    .filter(Boolean) as any[];

  return {
    artists: ordered.map(normalizeArtist),
    hasMore,
  };
}

/** Minimal artist shape returned by getRecommendedArtists. */
export interface RecommendedArtist {
  id: string;
  name: string;
  profile_image_url: string | null;
  enrichment_image: string | null;
}

/**
 * Fetch up to 10 recommended artists for a given artist page, ordered by rank.
 * Returns only the fields needed to render a compact avatar + name card.
 */
export async function getRecommendedArtists(
  artistId: string
): Promise<RecommendedArtist[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("artist_similarity_scores")
    .select(`
      rank,
      recommended:artists!recommended_artist_id(
        id,
        name,
        profile_image_url,
        enrichment:artist_enrichment(profile_image_url)
      )
    `)
    .eq("source_artist_id", artistId)
    .order("rank")
    .limit(10);

  if (error) {
    console.error("getRecommendedArtists error:", error);
    return [];
  }

  return (data ?? [])
    .map((row: any) => {
      const a = row.recommended;
      if (!a) return null;
      const enrichmentImage =
        (a.enrichment as Array<{ profile_image_url: string | null }> | null)
          ?.find((e) => e.profile_image_url)
          ?.profile_image_url ?? null;
      return {
        id:               a.id,
        name:             a.name,
        profile_image_url: a.profile_image_url ?? null,
        enrichment_image: enrichmentImage,
      };
    })
    .filter((a): a is RecommendedArtist => a !== null);
}

/** All approved genres that have at least one approved artist, for the filter UI. */
export async function getGenreOptions(): Promise<string[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("artist_genres")
    .select("genres!inner(name, status), artists!inner(directory_status, deleted)")
    .eq("artists.directory_status", "approved")
    .eq("artists.deleted", false)
    .eq("genres.status", "approved");

  if (error) {
    console.error("getGenreOptions error:", error);
    return [];
  }

  const names = new Set(
    (data ?? [])
      .map((row: any) => row.genres?.name as string | undefined)
      .filter((name): name is string => Boolean(name))
  );
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/** All countries with at least one approved artist, for the filter UI. */
export async function getCountryOptions(): Promise<string[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("artist_locations")
    .select("country, artists!inner(directory_status, deleted)")
    .eq("artists.directory_status", "approved")
    .eq("artists.deleted", false)
    .not("country", "is", null);

  if (error) {
    console.error("getCountryOptions error:", error);
    return [];
  }

  const countries = new Set(
    (data ?? []).map((l: any) => l.country as string).filter(Boolean)
  );
  return Array.from(countries).sort((a, b) => a.localeCompare(b));
}
