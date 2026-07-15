// TypeScript types mirroring the Supabase public schema (inspect live via
// read-only psql — see .env.local SUPABASE_DB_URL)

export type ArtistStatus =
  | "approved"
  | "pending"
  | "rejected"
  | "not_eligible"
  | "search_input"
  | "sc_followee"
  | "duplicate"
  | "unverified"
  | "obscure";

// ── Submission / revision system ─────────────────────────────────────────────

export type SubmitterEmailStatus = "unverified" | "verified" | "blocked";

export interface SubmitterEmail {
  email: string;
  status: SubmitterEmailStatus;
  first_seen_at: string;
  verified_at: string | null;
  submission_count: number;
  blocked_at: string | null;
  block_reason: string | null;
}

export type RevisionStatus = "unverified" | "pending" | "approved" | "rejected";

/** Shape stored in artist_revisions.revision_data (same fields as /api/submit body) */
export interface RevisionData {
  name?: string;
  pronouns?: string;
  genres?: string[];
  locations?: { city?: string; country?: string }[];
  labels?: string[];
  aliases?: string[];
  links?: Partial<Record<string, string>>;
}

export interface ArtistRevision {
  id: string;
  artist_id: string;
  submitted_by_email: string | null;
  status: RevisionStatus;
  submitter_notes: string | null;
  revision_data: RevisionData;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Profile-link platform key. Backed by the `platforms` lookup table
// (not a fixed enum) so new categories can be added from the admin
// panel without a code change. See lib/platforms.ts for fetching the
// full list and resolving keys to display labels.
export type LinkPlatform = string;

export interface Platform {
  key: string;
  label: string;
  sort_order: number;
  /**
   * Search-page URL template for the platform, with `{query}` as the
   * placeholder for the URL-encoded artist name (e.g.
   * "https://www.discogs.com/search?q={query}&type=artist"). NULL when the
   * platform has no usable search page. See buildPlatformSearchUrl().
   */
  search_url_template: string | null;
}

export interface Genre {
  id: number;
  name: string;
}

export interface Pronoun {
  id: number;
  value: string;
}

export interface ArtistLocation {
  id: number;
  artist_id: string;
  city: string | null;
  country: string | null;
  raw_text: string | null;
}

export interface ArtistLabel {
  id: number;
  artist_id: string;
  name: string;
}

export interface ArtistAlias {
  id: number;
  artist_id: string;
  name: string;
}

export interface ArtistLink {
  id: number;
  artist_id: string;
  platform: LinkPlatform;
  handle: string | null;
  url: string | null;
  original_url: string | null;
  not_found: boolean;
}

export interface RecentTrack {
  title: string;
  url: string;
  artwork_url?: string;
  plays?: number;
  published_at?: string;
}

/** A SoundCloud playlist (set), used as a widget fallback for accounts
 *  with zero uploaded tracks. See artist_enrichment.playlists. */
export interface EnrichedPlaylist {
  title: string;
  url: string;
  track_count: number;
}

export interface BandcampAlbum {
  id: number;
  artist_id: string;
  bandcamp_id: string;
  item_type: "album" | "track";
  title: string | null;
  url: string | null;
  sort_order: number;
}

/**
 * One stored image for an artist from a given platform. See
 * supabase_migration_artist_images.sql — unique on (artist_id,
 * platform), so an artist can hold several of these at once (one per
 * platform that turned up a usable profile photo) instead of a single
 * artists.profile_image_url winner. storage_url is set once
 * store-images.mjs has re-hosted the image to Supabase Storage;
 * source_url (the original external URL) is used as a fallback until
 * then. See src/lib/artist-images.ts for how one gets picked for
 * display.
 */
export interface ArtistImage {
  artist_id: string;
  platform: LinkPlatform;
  source_url: string;
  storage_url: string | null;
  storage_path: string | null;
  fetched_at: string;
  stored_at: string | null;
}

export interface ArtistEnrichment {
  id: number;
  artist_id: string;
  platform: LinkPlatform;
  external_id: string | null;
  profile_image_url: string | null;
  bio: string | null;
  /** DOMPurify-sanitized HTML version of bio. Rendered via dangerouslySetInnerHTML on the artist page. */
  bio_sanitized: string | null;
  follower_count: number | null;
  track_count: number | null;
  recent_tracks: RecentTrack[] | null;
  /** Only populated when track_count is 0 — see the artist_enrichment
   *  migration comment for why. Null/empty means either the account
   *  has tracks (so this wasn't fetched) or has no public playlists either. */
  playlists: EnrichedPlaylist[] | null;
  last_synced_at: string | null;
  sync_error: string | null;
}

export interface Artist {
  id: string;
  name: string;
  pronoun_id: number | null;
  labels: string | null;
  notes: string | null;
  directory_status: ArtistStatus;
  submitted_by_email: string | null;
  submitted_at: string | null;
  profile_image_url: string | null;
  profile_image_source: LinkPlatform | null;
  profile_image_fetched_at: string | null;
  // sc_image_url intentionally omitted: supabase_migration_sc_image_url.sql
  // exists in the repo but has never been applied to the live database, so
  // this column does not exist there (confirmed against a live schema dump,
  // 2026-07-09) — querying it fails with "column a.sc_image_url does not
  // exist". Only add it back if that migration is actually run. See
  // supabase_migration_backfill_artist_images.sql step 1 for the guarded
  // SQL read that already handles both states.
  booking_info: string | null;
  management_info: string | null;
  contact_info: string | null;
  deleted: boolean;
  created_at: string;
  updated_at: string;
}

// Shape returned by the directory query: artist + joined relations
export interface ArtistWithRelations extends Artist {
  pronoun: Pronoun | null;
  genres: Genre[];
  locations: ArtistLocation[];
  label_list: ArtistLabel[];
  aliases: ArtistAlias[];
  links: ArtistLink[];
  enrichment: ArtistEnrichment[];
  bandcamp_albums?: BandcampAlbum[];
  /** Every stored image for this artist, across all platforms. */
  images: ArtistImage[];
  /**
   * One image URL picked from `images`, deterministically seeded by
   * artist_id + today's date — see src/lib/artist-images.ts. Null
   * when the artist has no stored images. This is what components
   * should render; `profile_image_url` (inherited from Artist) is the
   * legacy single-slot column and is no longer kept up to date by any
   * writer.
   */
  displayImageUrl: string | null;
}

// Filter options shown in the directory UI
export interface DirectoryFilters {
  genre?: string;
  country?: string;
  search?: string;
  /** 1-indexed page number */
  page?: number;
}

// Result of a paginated artist query
export interface ArtistPage {
  artists: ArtistWithRelations[];
  /** Whether at least one more page of results exists after this one */
  hasMore: boolean;
}
