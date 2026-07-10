import { unstable_cache } from "next/cache";
import { getSupabaseClient } from "./supabase";
import { pickArtistImage } from "./artist-images";
import type {
  ArtistPage,
  ArtistWithRelations,
  DirectoryFilters,
  Artist,
  Pronoun,
  Genre,
  ArtistLocation,
  ArtistLabel,
  ArtistAlias,
  ArtistLink,
  ArtistEnrichment,
  ArtistImage,
  BandcampAlbum,
} from "./types";

// Raw shape of a row returned by ARTIST_SELECT below, before genres are
// flattened out of the artist_genres junction rows.
type RawArtistRow = Artist & {
  pronoun: Pronoun | null;
  artist_genres: { genres: (Genre & { status?: string }) | null }[];
  locations: ArtistLocation[];
  label_list: ArtistLabel[];
  aliases: ArtistAlias[];
  links: ArtistLink[];
  enrichment: ArtistEnrichment[];
  images: ArtistImage[];
  bandcamp_albums?: BandcampAlbum[];
};

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
  images:artist_images(platform, source_url, storage_url, storage_path, fetched_at, stored_at),
  bandcamp_albums:artist_bandcamp_albums(*)
`;

// Flatten the nested artist_genres(genres(*)) shape into a plain
// genres[] array on each artist for easier use in components, and
// resolve which stored image to display (see src/lib/artist-images.ts).
function normalizeArtist(row: RawArtistRow): ArtistWithRelations {
  const genres: Genre[] = (row.artist_genres ?? [])
    .map((ag) => ag.genres)
    .filter((g): g is Genre & { status?: string } => g?.status === "approved");

  return {
    ...row,
    genres,
    images: row.images ?? [],
    displayImageUrl: pickArtistImage(row.id, row.images),
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
    const term = normalizeSearch(filters.search);
    const like = `%${term}%`;

    // Match on the primary name OR any alias. Aliases live in their own
    // table (an artist can have several), so first collect the ids of
    // artists whose alias matches, then OR those into the main filter.
    // artist_aliases.name_search mirrors artists.name_search, so the same
    // normalized term matches both columns identically.
    const { data: aliasRows, error: aliasError } = await supabase
      .from("artist_aliases")
      .select("artist_id")
      .ilike("name_search", like);

    if (aliasError) {
      console.error("getArtists alias search error:", aliasError);
    }

    const aliasIds = Array.from(
      new Set(
        (aliasRows ?? []).map((r: { artist_id: string }) => r.artist_id)
      )
    );

    if (aliasIds.length > 0) {
      // Within .or(), ilike uses `*` as the wildcard (not `%`); the pattern
      // is double-quoted so terms containing commas/periods/parens (e.g.
      // "Tyler, the Creator", "M.I.A.") don't break the filter grammar.
      query = query.or(
        `name_search.ilike."*${term}*",id.in.(${aliasIds.join(",")})`
      );
    } else {
      query = query.ilike("name_search", like);
    }
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

  // The select string is built dynamically (not a literal), so supabase-js
  // can't infer its shape — cast through unknown to our known row shape.
  const rows = (data ?? []) as unknown as RawArtistRow[];
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
  const byId = new Map((data ?? []).map((a: RawArtistRow) => [a.id, a]));
  const ordered = pageIds
    .map((id) => byId.get(id))
    .filter((a): a is RawArtistRow => Boolean(a));

  return {
    artists: ordered.map(normalizeArtist),
    hasMore,
  };
}

/** Minimal artist shape returned by getRecommendedArtists. */
export interface RecommendedArtist {
  id: string;
  name: string;
  image_url: string | null;
}

/**
 * Fetch up to 10 recommended artists for a given artist page, ordered by rank.
 * Returns only the fields needed to render a compact avatar + name card.
 */
export async function getRecommendedArtists(
  artistId: string
): Promise<RecommendedArtist[]> {
  const supabase = getSupabaseClient();

  type RecommendedScoreRow = {
    rank: number;
    recommended: {
      id: string;
      name: string;
      images: ArtistImage[] | null;
    } | null;
  };

  const { data, error } = await supabase
    .from("artist_similarity_scores")
    .select(`
      rank,
      recommended:artists!recommended_artist_id(
        id,
        name,
        images:artist_images(platform, source_url, storage_url)
      )
    `)
    .eq("source_artist_id", artistId)
    .order("rank")
    .limit(10);

  if (error) {
    console.error("getRecommendedArtists error:", error);
    return [];
  }

  return ((data as unknown as RecommendedScoreRow[]) ?? [])
    .map((row) => {
      const a = row.recommended;
      if (!a) return null;
      return {
        id: a.id,
        name: a.name,
        image_url: pickArtistImage(a.id, a.images),
      };
    })
    .filter((a): a is RecommendedArtist => a !== null);
}

/** All approved genres that have at least one approved artist, for the filter UI. */
/**
 * Minimum number of approved, non-deleted artists a genre must have to
 * appear in the public genre filter. Genres at or below (this − 1) are
 * hidden "live" at read time: nothing is written to the database, so a
 * genre reappears automatically once it crosses the threshold, and this
 * is fully independent of genres.status (manual moderation stays separate).
 * Set to 3 → any genre with ≤2 approved artists is hidden.
 */
export const MIN_APPROVED_ARTISTS_FOR_GENRE = 3;

async function computeGenreOptions(): Promise<string[]> {
  const supabase = getSupabaseClient();

  type GenreOptionRow = { genres: { name: string } | null };

  // One row per (approved non-deleted artist × approved genre) link, so
  // counting rows per genre = its number of approved artists. Page through
  // because PostgREST caps a single response at ~1000 rows and there are
  // typically far more artist-genre links than that.
  const PAGE = 1000;
  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("artist_genres")
      .select("genres!inner(name, status), artists!inner(directory_status, deleted)")
      .eq("artists.directory_status", "approved")
      .eq("artists.deleted", false)
      .eq("genres.status", "approved")
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("getGenreOptions error:", error);
      return [];
    }

    const rows = (data as unknown as GenreOptionRow[]) ?? [];
    for (const row of rows) {
      const name = row.genres?.name;
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
  }

  return Array.from(counts.entries())
    .filter(([, n]) => n >= MIN_APPROVED_ARTISTS_FOR_GENRE)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Public genre filter list — genres with ≥ MIN_APPROVED_ARTISTS_FOR_GENRE
 * approved artists. Cached across requests so the heavy per-genre count
 * doesn't run on every page load; it recomputes at most once every
 * `revalidate` seconds (the list only changes as artists are approved/
 * removed, so short staleness is fine). Bump the window down for fresher
 * results or up to cut load further.
 */
export const getGenreOptions = unstable_cache(
  computeGenreOptions,
  ["genre-options"],
  { revalidate: 600, tags: ["genres"] },
);

async function computeGenrePickerOptions(): Promise<string[]> {
  const supabase = getSupabaseClient();

  type GenreRow = { name: string };

  // Every approved genre, regardless of how many artists use it. Page
  // through because PostgREST caps a single response at ~1000 rows.
  const PAGE = 1000;
  const names: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("genres")
      .select("name")
      .eq("status", "approved")
      .order("name")
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("getGenrePickerOptions error:", error);
      return [];
    }

    const rows = (data as GenreRow[]) ?? [];
    for (const row of rows) {
      if (row.name) names.push(row.name);
    }
    if (rows.length < PAGE) break;
  }

  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Genre list for the submit / edit / revise pickers — ALL approved genres,
 * with no artist-count gate. Unlike getGenreOptions() (the browse filter,
 * which hides genres below MIN_APPROVED_ARTISTS_FOR_GENRE to stay tidy), the
 * pickers must offer every legitimate genre so rare or newly-approved ones
 * can be tagged at all. A genre appears here the moment it is set to
 * status='approved', and self-promotes into the browse filter once it
 * reaches the artist threshold. Cached like the filter list.
 */
export const getGenrePickerOptions = unstable_cache(
  computeGenrePickerOptions,
  ["genre-picker-options"],
  { revalidate: 600, tags: ["genres"] },
);

/** All countries with at least one approved artist, for the filter UI. */
/**
 * Reads the precomputed, rounded-down count of directory ("approved")
 * artists from site_stats. This is refreshed daily by the pg_cron job in
 * supabase_migration_site_stats.sql, so the homepage reads ONE row rather
 * than counting on every request. Returns null if the row is missing.
 */
export async function getApprovedArtistCount(): Promise<number | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("site_stats")
    .select("value_int")
    .eq("key", "approved_artist_count")
    .maybeSingle();

  if (error) {
    console.error("getApprovedArtistCount error:", error);
    return null;
  }
  return data?.value_int ?? null;
}

/**
 * Reads an editable text block from site_content (e.g. the /about page),
 * managed from the admin panel. Returns null if the row is missing or the
 * table hasn't been created yet, so callers can fall back to default copy.
 */
export async function getSiteContent(key: string): Promise<string | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("site_content")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    console.error("getSiteContent error:", error);
    return null;
  }
  return data?.value ?? null;
}

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

  type CountryOptionRow = { country: string | null };

  const countries = new Set(
    (data ?? [])
      .map((l: CountryOptionRow) => l.country)
      .filter((c): c is string => Boolean(c))
  );
  return Array.from(countries).sort((a, b) => a.localeCompare(b));
}
