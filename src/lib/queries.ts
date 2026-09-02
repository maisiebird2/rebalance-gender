import { unstable_cache } from "next/cache";
import { getSupabaseClient, getSupabaseAdminClient } from "./supabase";
import { pickArtistImage } from "./artist-images";
import { normalisedNameKey } from "./name-key.mjs";
import { PUBLIC_ARTIST_COLUMNS } from "./artist-columns.mjs";
import type {
  ArtistPage,
  ArtistWithRelations,
  DirectoryFilters,
  Artist,
  Pronoun,
  Genre,
  ArtistType,
  ArtistLocation,
  ArtistLabel,
  ArtistAlias,
  ArtistLink,
  ArtistEnrichment,
  ArtistImage,
  BandcampAlbum,
  ArtistOrganisationEntry,
  OrganisationArtistEntry,
  OrganisationLink,
  OrganisationLocation,
  OrganisationPage,
  OrganisationRole,
  OrganisationType,
  OrganisationStatus,
  OrganisationSummary,
} from "./types";

// Raw shape of a row returned by ARTIST_SELECT below, before genres are
// flattened out of the artist_genres junction rows.
type RawArtistRow = Artist & {
  pronoun: Pronoun | null;
  artist_genres: { genres: (Genre & { status?: string }) | null }[];
  // One row per (type × source); flattened + deduped to types[] below.
  artist_type_assignments: { artist_types: ArtistType | null }[];
  locations: ArtistLocation[];
  label_list: ArtistLabel[];
  // One row per (artist × organisation × role). `organisation` is null
  // only when RLS hid it, which the public client can't see anyway.
  artist_organisations: {
    role: OrganisationRole | null;
    organisation: (OrganisationSummary & { status: OrganisationStatus }) | null;
  }[];
  aliases: ArtistAlias[];
  links: ArtistLink[];
  enrichment: ArtistEnrichment[];
  images: ArtistImage[];
  bandcamp_albums?: BandcampAlbum[];
};

// Raw shape of a row returned by ORGANISATION_SELECT, before the nested
// junction rows are flattened.
type RawOrganisationRow = {
  id: string;
  name: string;
  status: OrganisationStatus;
  duplicate_of: string | null;
  run_by_text: string | null;
  created_at: string;
  updated_at: string;
  types: { type: OrganisationType | null }[];
  locations: OrganisationLocation[];
  links: OrganisationLink[];
  artist_organisations: {
    role: OrganisationRole | null;
    artist: { id: string; name: string } | null;
  }[];
};

export const PAGE_SIZE = 24;

// Shared select string: pulls the artist plus all joined relations
// (pronoun, genres via the artist_genres junction table, locations,
// links, and cached enrichment data).
//
// The artist columns come from PUBLIC_ARTIST_COLUMNS rather than being
// spelled out here, and rather than `*`: anon and authenticated only hold
// column-level SELECT grants on artists (see
// supabase_migration_artists_private_columns.sql), and PostgREST rejects
// `select=*` for a role that can't read every column. That module explains
// the grant rules and is shared with
// scripts/check-artists-column-grants.mjs, so the checker probes the same
// list the site selects instead of a copy of it.
//
// The nested organisations(...) select names its columns for exactly the
// same reason: organisations.notes is admin-only, so `*` on that table is
// rejected for the public roles too.
const ARTIST_SELECT = `
  ${PUBLIC_ARTIST_COLUMNS.join(",\n  ")},
  pronoun:pronouns(*),
  artist_genres(genres(*)),
  artist_type_assignments(artist_types(*)),
  locations:artist_locations(*),
  label_list:artist_labels(*),
  artist_organisations(
    role:organisation_roles(key, label, sort_order),
    organisation:organisations(id, name, status)
  ),
  aliases:artist_aliases(*),
  links:artist_links(*),
  enrichment:artist_enrichment(*),
  images:artist_images(platform, source_url, storage_url, storage_path, fetched_at, stored_at),
  bandcamp_albums:artist_bandcamp_albums(*)
`;

// Lean select for the directory GRID (ArtistCard). The card only renders
// name, image, aliases, pronoun, genres, and locations — so unlike
// ARTIST_SELECT it deliberately omits the heavy relations (enrichment
// bios, artist_links, bandcamp_albums, labels) that were being joined and
// shipped for every one of the 24 tiles per page but never displayed.
// Keep this in sync with the fields ArtistCard.tsx actually reads.
// normalizeArtist() needs genres.status (to keep only approved) and the
// full images columns (to resolve displayImageUrl via pickArtistImage).
// artist_type_assignments carries the role pills (producer/DJ/vocalist).
const CARD_SELECT = `
  id,
  name,
  directory_status,
  pronoun:pronouns(*),
  artist_genres(genres(id, name, status)),
  artist_type_assignments(artist_types(id, name, label, sort_order)),
  locations:artist_locations(city, country),
  aliases:artist_aliases(name),
  images:artist_images(platform, source_url, storage_url, storage_path, fetched_at, stored_at)
`;

// Flatten the nested artist_genres(genres(*)) shape into a plain
// genres[] array on each artist for easier use in components, and
// resolve which stored image to display (see src/lib/artist-images.ts).
function normalizeArtist(row: RawArtistRow): ArtistWithRelations {
  const genres: Genre[] = (row.artist_genres ?? [])
    .map((ag) => ag.genres)
    .filter((g): g is Genre & { status?: string } => g?.status === "approved");

  // The junction holds one row per (type × source), so the same type can
  // appear several times (e.g. tagged 'manual' AND harvested from discogs).
  // Collapse to one entry per type id, then order by sort_order.
  const typesById = new Map<number, ArtistType>();
  for (const ta of row.artist_type_assignments ?? []) {
    if (ta.artist_types) typesById.set(ta.artist_types.id, ta.artist_types);
  }
  const types: ArtistType[] = Array.from(typesById.values()).sort(
    (a, b) => a.sort_order - b.sort_order
  );

  // One row per (organisation × role). The two-sided RLS policy already
  // limits the PUBLIC client to associations where both the artist and
  // the organisation are approved, but the admin client bypasses RLS —
  // so filter on status here as well. That makes an unapproved
  // organisation read as absent for every viewer, which is precisely
  // what the artist page's dual-read fallback depends on: an artist
  // whose only organisation is still pending keeps showing the old flat
  // label text instead of losing the line entirely.
  //
  // CARD_SELECT doesn't join this at all (the grid never renders it), so
  // the field is simply absent there and the ?? [] covers it.
  const organisations: ArtistOrganisationEntry[] = (row.artist_organisations ?? [])
    .flatMap((ao) =>
      ao.role && ao.organisation?.status === "approved"
        ? [{
            organisation: { id: ao.organisation.id, name: ao.organisation.name },
            role: ao.role,
          }]
        : []
    )
    .sort((a, b) => a.organisation.name.localeCompare(b.organisation.name));

  return {
    ...row,
    genres,
    types,
    organisations,
    images: row.images ?? [],
    displayImageUrl: pickArtistImage(row.id, row.images),
  };
}

/**
 * Fetch one page of approved artists, optionally filtered by genre,
 * country, and a free-text search over the artist name. The search matches
 * substrings by default; `filters.exact` narrows it to the whole name.
 *
 * Genre/country filters use `!inner` joins so that only artists with a
 * matching related row are returned. Results are paginated using
 * `PAGE_SIZE`; `filters.page` is 1-indexed (defaults to 1).
 *
 * `includeNonApproved` (admin viewers only — never pass it for anonymous
 * traffic) switches to the RLS-bypassing admin client and drops the
 * approved-only filter, so artists in every directory_status are listed.
 * Soft-deleted rows (deleted = true) stay hidden for everyone.
 */
export async function getArtists(
  filters: DirectoryFilters = {},
  { includeNonApproved = false }: { includeNonApproved?: boolean } = {}
): Promise<ArtistPage> {
  const supabase = includeNonApproved
    ? getSupabaseAdminClient()
    : getSupabaseClient();

  // The grid uses the lean CARD_SELECT (see note above) rather than the
  // full ARTIST_SELECT — the homepage renders ArtistCard, which reads only
  // a handful of fields. The genre/country replace targets below must match
  // the strings in CARD_SELECT, not ARTIST_SELECT.
  let select = CARD_SELECT;
  if (filters.genre) {
    select = select.replace(
      "artist_genres(genres(id, name, status))",
      "artist_genres!inner(genres!inner(id, name, status))"
    );
  }
  if (filters.country) {
    select = select.replace(
      "locations:artist_locations(city, country)",
      "locations:artist_locations!inner(city, country)"
    );
  }

  let query = supabase
    .from("artists")
    .select(select)
    .eq("deleted", false)
    .order("name");

  if (!includeNonApproved) {
    query = query.eq("directory_status", "approved");
  }

  if (filters.genre) {
    query = query.eq("artist_genres.genres.name", filters.genre);
  }
  if (filters.country) {
    query = query.eq("locations.country", filters.country);
  }
  if (filters.search) {
    const term = normalisedNameKey(filters.search);

    // A term that normalises to nothing has no key to match on: "???", or a
    // name written entirely in a script unaccent() can't romanise ("МОЛЧАТ
    // ДОМА"). It must not fall through to a pattern. In substring mode that
    // pattern is `%%`, the empty LIKE pattern, which matches every artist;
    // in exact mode it is `""`, which matches exactly those artists whose
    // own name_search is empty — every non-Latin name in the directory,
    // handed back as though they were hits. Those artists store an empty
    // name_search too, so there is genuinely nothing for such a term to find.
    if (!term) {
      return { artists: [], hasMore: false };
    }

    // `exact` swaps the substring pattern for the bare term, turning the
    // match into whole-name equality: "Vel" then finds the artist called
    // Vel and not "Velvet Underground" or "A Lovely Butt". It stays an
    // ILIKE rather than becoming .eq() for two reasons — the pg_trgm GIN
    // index on name_search serves LIKE/ILIKE patterns but not `=`, and
    // both sides are already lowercase [a-z0-9] (normalisedNameKey strips
    // the rest, so no % or _ can sneak in as a wildcard), which makes a
    // wildcard-free ILIKE exactly an equality test. Matching is still on
    // the *normalised* key, so case, accents, spacing and punctuation are
    // ignored in exact mode too: "V.E.L" matches the artist "Vel", and
    // "otta" matches "ØTTA".
    const pattern = filters.exact ? term : `%${term}%`;

    // Match on the primary name OR any alias. Aliases live in their own
    // table (an artist can have several), so first collect the ids of
    // artists whose alias matches, then OR those into the main filter.
    // artist_aliases.name_search mirrors artists.name_search, so the same
    // normalised term matches both columns identically.
    const { data: aliasRows, error: aliasError } = await supabase
      .from("artist_aliases")
      .select("artist_id")
      .ilike("name_search", pattern);

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
      const orPattern = filters.exact ? term : `*${term}*`;
      query = query.or(
        `name_search.ilike."${orPattern}",id.in.(${aliasIds.join(",")})`
      );
    } else {
      query = query.ilike("name_search", pattern);
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

  // Same cast as getArtists: the select string is assembled at runtime, so
  // supabase-js's inferred row shape doesn't match reality (it can't know
  // the to-one embeds) — go through unknown to the shape we know we get.
  const rows = (data ?? []) as unknown as RawArtistRow[];
  return {
    artists: rows.slice(0, PAGE_SIZE).map(normalizeArtist),
    hasMore: rows.length > PAGE_SIZE,
  };
}

/**
 * Fetch a single approved artist (with all relations) by id, for the detail
 * page. With `includeNonApproved` (admin viewers only) the artist is returned
 * regardless of directory_status; soft-deleted rows stay hidden either way.
 */
export async function getArtistById(
  id: string,
  { includeNonApproved = false }: { includeNonApproved?: boolean } = {}
): Promise<ArtistWithRelations | null> {
  const supabase = includeNonApproved
    ? getSupabaseAdminClient()
    : getSupabaseClient();

  let query = supabase
    .from("artists")
    .select(ARTIST_SELECT)
    .eq("id", id)
    .eq("deleted", false);

  if (!includeNonApproved) {
    query = query.eq("directory_status", "approved");
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error("getArtistById error:", error);
    return null;
  }
  if (!data) return null;

  // Cast through unknown for the same reason as in getArtists: supabase-js
  // misinfers the embed shapes (e.g. pronoun as an array) from the select
  // string.
  return normalizeArtist(data as unknown as RawArtistRow);
}

/**
 * Fetch a randomly-ordered page of approved artists (no filters applied).
 *
 * Sampling happens in Postgres via the random_approved_artist_ids() RPC
 * (see supabase_migration_random_approved_artists.sql), so we ship back a
 * small, constant number of ids per request instead of dumping the entire
 * directory's id list to Node and shuffling it here. Each request is an
 * independent random draw — same discovery behaviour as before, and, as
 * before, an artist may reappear across page loads since every load
 * reshuffles.
 *
 * Two round-trips: (1) the RPC for this page's random ids, (2) the card
 * data for those ids. hasMore comes from the precomputed approved count
 * (one indexed row) rather than the full id list.
 */
export async function getRandomArtists(page: number = 1): Promise<ArtistPage> {
  const supabase = getSupabaseClient();

  // 1. Ask Postgres for a random sample of approved ids (constant payload).
  const { data: idRows, error: idError } = await supabase.rpc(
    "random_approved_artist_ids",
    { sample_size: PAGE_SIZE }
  );

  if (idError || !idRows) {
    console.error("getRandomArtists id error:", idError);
    return { artists: [], hasMore: false };
  }

  const pageIds = (idRows as { id: string }[]).map((r) => r.id);
  if (pageIds.length === 0) return { artists: [], hasMore: false };

  // 2. "More pages exist" just means the directory holds more than we've
  // shown so far. Because each load is an independent random draw, we can't
  // (and needn't) track a stable offset — read the precomputed count.
  const approvedCount = await getApprovedArtistCount();
  const hasMore =
    approvedCount != null && Math.max(1, page) * PAGE_SIZE < approvedCount;

  // 3. Fetch card data for this page's ids.
  const { data, error } = await supabase
    .from("artists")
    .select(CARD_SELECT)
    .in("id", pageIds)
    .eq("directory_status", "approved")
    .eq("deleted", false);

  if (error) {
    console.error("getRandomArtists fetch error:", error);
    return { artists: [], hasMore: false };
  }

  // 4. Re-order to match the RPC's random id order (DB returns arbitrary order)
  const rows = (data ?? []) as unknown as RawArtistRow[];
  const byId = new Map(rows.map((a) => [a.id, a]));
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

// ── Organisations ────────────────────────────────────────────────────────────

// Columns are listed explicitly for the same reason ARTIST_SELECT lists
// them: organisations.notes has no grant for the public roles, so `*` is
// rejected outright. `description` is deliberately not requested — the
// column exists but nothing renders it yet (phase 4 decision).
const ORGANISATION_SELECT = `
  id,
  name,
  status,
  duplicate_of,
  run_by_text,
  created_at,
  updated_at,
  types:organisation_type_links(type:organisation_types(key, label, sort_order)),
  locations:organisation_locations(id, organisation_id, city, country),
  links:organisation_links(id, organisation_id, platform, handle, url, original_url, not_found),
  artist_organisations(
    role:organisation_roles(key, label, sort_order),
    artist:artists(id, name)
  )
`;

/**
 * Fetch one approved organisation with everything the public page renders.
 *
 * Always the PUBLIC client, never the admin one — unlike artists, there is
 * no admin preview of an unapproved organisation, and going through the
 * public client is what makes the two-sided RLS policy do the filtering:
 * the artist list can only ever contain approved artists, and an
 * unapproved organisation is invisible outright. `status = 'approved'` is
 * still stated here so the intent is readable without knowing the policy.
 *
 * Returns null when the id doesn't exist, isn't approved, or has been
 * merged into another organisation — a merged row keeps its associations
 * pointing at the winner, so rendering it would show an empty page.
 */
export async function getOrganisationById(
  id: string,
): Promise<OrganisationPage | null> {
  const { data, error } = await getSupabaseClient()
    .from("organisations")
    .select(ORGANISATION_SELECT)
    .eq("id", id)
    .eq("status", "approved")
    .is("duplicate_of", null)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as unknown as RawOrganisationRow;

  const types = (row.types ?? [])
    .map((t) => t.type)
    .filter((t): t is OrganisationType => t !== null)
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));

  // One entry per (artist × role), sorted by artist name so each role's
  // line reads alphabetically. RLS has already dropped any artist that
  // isn't approved, so no status filter is needed here.
  const artists: OrganisationArtistEntry[] = (row.artist_organisations ?? [])
    .flatMap((ao) =>
      ao.role && ao.artist ? [{ artist: ao.artist, role: ao.role }] : [],
    )
    .sort((a, b) => a.artist.name.localeCompare(b.artist.name));

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    run_by_text: row.run_by_text,
    types,
    locations: row.locations ?? [],
    links: row.links ?? [],
    artists,
  };
}

/**
 * Approved organisations for the submit / revise / edit pickers.
 *
 * Only approved, non-merged rows: a pending organisation is one nobody has
 * looked at yet, and offering stranger-supplied text back to the next
 * submitter as a suggestion is exactly what the moderation queue exists to
 * prevent. A submitter whose organisation isn't listed types the name, and it
 * becomes an organisation when an admin approves the artist.
 *
 * Small enough to hand to the form as a prop (55 approved at the time of
 * writing, ~240 once the backfill queue is worked through), which is how the
 * genre picker does it too — so there is no autocomplete endpoint to build,
 * rate-limit or protect.
 *
 * The "organisations" tag is what makes an approval show up in the pickers
 * straight away; every write in src/app/admin/organisations/actions.ts busts
 * it through revalidateOrganisation(). The `revalidate` window below is only
 * the backstop for changes made outside the app, such as SQL run by hand in
 * the Supabase editor.
 */
async function computeOrganisationPickerOptions(): Promise<OrganisationSummary[]> {
  const { data, error } = await getSupabaseClient()
    .from("organisations")
    .select("id, name")
    .eq("status", "approved")
    .is("duplicate_of", null)
    .order("name")
    .limit(1000);

  if (error) {
    console.error("getOrganisationPickerOptions error:", error);
    return [];
  }
  return (data ?? []) as OrganisationSummary[];
}

export const getOrganisationPickerOptions = unstable_cache(
  computeOrganisationPickerOptions,
  ["organisation-picker-options"],
  { revalidate: 600, tags: ["organisations"] },
);
