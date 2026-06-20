// TypeScript types mirroring supabase_schema.sql

export type ArtistStatus = "approved" | "pending" | "rejected";

export type LinkPlatform =
  | "soundcloud"
  | "instagram"
  | "resident_advisor"
  | "bandcamp"
  | "beatport"
  | "qobuz"
  | "discogs"
  | "linktree"
  | "apple_music"
  | "spotify"
  | "musicbrainz"
  | "lastfm"
  | "homepage"
  | "wikipedia"
  | "other";

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

export interface ArtistLink {
  id: number;
  artist_id: string;
  platform: LinkPlatform;
  handle: string | null;
  url: string;
}

export interface RecentTrack {
  title: string;
  url: string;
  artwork_url?: string;
  plays?: number;
  published_at?: string;
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

export interface ArtistEnrichment {
  id: number;
  artist_id: string;
  platform: LinkPlatform;
  external_id: string | null;
  profile_image_url: string | null;
  bio: string | null;
  follower_count: number | null;
  track_count: number | null;
  recent_tracks: RecentTrack[] | null;
  last_synced_at: string | null;
  sync_error: string | null;
}

export interface Artist {
  id: string;
  name: string;
  pronoun_id: number | null;
  labels: string | null;
  notes: string | null;
  status: ArtistStatus;
  profile_image_url: string | null;
  profile_image_source: LinkPlatform | null;
  profile_image_fetched_at: string | null;
  booking_info: string | null;
  management_info: string | null;
  contact_info: string | null;
  linktree_url: string | null;
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
  links: ArtistLink[];
  enrichment: ArtistEnrichment[];
  bandcamp_albums?: BandcampAlbum[];
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
  /** Total number of artists matching the filters, across all pages */
  count: number;
}
