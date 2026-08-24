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
  | "obscure"
  | "not_electronic"
  | "label_etc";

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
  /**
   * BACK-COMPAT. Revisions written before the organisation picker shipped
   * carry plain label strings here; newer ones carry `organisations`
   * instead. approveRevision() applies whichever is present, because a
   * revision already sitting in the queue was written by the old form.
   */
  labels?: string[];
  organisations?: OrganisationFormRow[];
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

/**
 * A role an artist can be tagged with — 'producer', 'dj', 'vocalist'.
 * Backed by the closed, hand-seeded `artist_types` lookup (see
 * supabase_migration_artist_types.sql), not a harvested vocabulary like
 * genres. `name` is the canonical slug; `label` is the display form
 * ('dj' → 'DJ'); `sort_order` gives stable UI ordering.
 */
export interface ArtistType {
  id: number;
  name: string;
  label: string;
  sort_order: number;
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
  /**
   * PRIVATE column (admin-only internal notes). anon/authenticated have no
   * SELECT grant on it — see supabase_migration_artists_private_columns.sql —
   * so it is absent from rows loaded through the public client (whose
   * ARTIST_SELECT doesn't request it, and couldn't). Present only on rows
   * loaded through the service-role client (edit page, admin panel).
   * Same deal for submitted_by_email and submitted_at below.
   */
  notes?: string | null;
  directory_status: ArtistStatus;
  /**
   * The artist this row duplicates, when directory_status is 'duplicate'.
   * Null otherwise, and also null for a duplicate whose canonical entry
   * hasn't been identified yet. Set from the edit form; cleared whenever the
   * status moves off 'duplicate'. See
   * supabase_migration_artist_duplicate_of.sql.
   */
  duplicate_of: string | null;
  /** PRIVATE column — see the note on `notes` above. */
  submitted_by_email?: string | null;
  /** PRIVATE column — see the note on `notes` above. */
  submitted_at?: string | null;
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
  /**
   * The artist's roles (producer / DJ / vocalist), deduped down to one
   * entry per type across however many sources claimed it, ordered by
   * sort_order. See normalizeArtist() in queries.ts.
   */
  types: ArtistType[];
  locations: ArtistLocation[];
  /**
   * The legacy flat label strings. Still read during the organisations
   * transition: the artist page renders `organisations` when there are any
   * and falls back to this otherwise, so no artist loses the line while the
   * backfilled organisations are still being approved. Goes away with
   * artist_labels in the cleanup phase.
   */
  label_list: ArtistLabel[];
  /**
   * Approved organisations this artist is attached to, one entry per role,
   * sorted by organisation name. Group with groupByRole() from
   * lib/organisations.ts to render. Empty on grid rows (CARD_SELECT).
   */
  organisations: ArtistOrganisationEntry[];
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

// ── Organisations (record labels, clubs, events) ─────────────────────────────
//
// Phase 1–3 of documentation/PROPOSAL-organisations.md. The replacement for
// the flat `artist_labels(artist_id, name)` strings: each organisation is its
// own row with links, types, a location and typed relationships to the artists
// in the directory. artist_labels / ArtistLabel are still read during the
// transition (dual-read) and go away in the cleanup phase.

export type OrganisationStatus = "pending" | "approved" | "rejected" | "deleted";

/**
 * A kind of organisation — 'record label', 'club', 'radio'. MANY-TO-MANY with
 * organisations (via organisation_type_links): Tresor is a club and a label,
 * Boiler Room a show and a promoter.
 *
 * A table rather than a Postgres enum, for the same reason `platforms` is one:
 * "distributor" can be added without a code change. `key` is the slugify()
 * form of `label`.
 */
export interface OrganisationType {
  key: string;
  label: string;
  sort_order: number;
}

/**
 * A role an artist holds at an organisation — 'associated', 'head', 'founder',
 * 'resident'. Editable vocabulary, seeded by
 * supabase_migration_organisations.sql and maintained from /admin/settings.
 *
 * 'associated' is the default and is exactly what the old flat label text
 * meant, so it is what the backfill assigns to every migrated row.
 */
export interface OrganisationRole {
  key: string;
  label: string;
  sort_order: number;
}

export interface OrganisationLocation {
  id: number;
  organisation_id: string;
  city: string | null;
  country: string | null;
}

export interface OrganisationLink {
  id: number;
  organisation_id: string;
  platform: LinkPlatform;
  handle: string | null;
  url: string | null;
  original_url: string | null;
  not_found: boolean;
}

/**
 * The typed relationship between an artist and an organisation. `role_key` is
 * part of the primary key, so one artist can hold several roles at the same
 * organisation (owner AND resident) without duplicate-row hacks.
 *
 * One table serves both directions: the artist page reads it as "associated
 * with", the organisation page as "run by".
 */
export interface ArtistOrganisation {
  artist_id: string;
  organisation_id: string;
  role_key: string;
  created_at: string;
}

export interface Organisation {
  id: string;
  name: string;
  status: OrganisationStatus;
  /**
   * The organisation this row duplicates, set by the admin merge action which
   * also repoints the artist_organisations rows. Free-text entry keeps
   * producing "Ostgut Ton" / "ostgut-ton" pairs; this is where the loser goes.
   * Mirrors artists.duplicate_of.
   */
  duplicate_of: string | null;
  /** Short public blurb. Optional and usually empty. */
  description: string | null;
  /**
   * Free text for the people who run it and are NOT in the directory (labels
   * run by men, etc.). People who ARE get an artist_organisations row with an
   * owner/founder/head role instead.
   */
  run_by_text: string | null;
  /**
   * PRIVATE column (admin-only). anon/authenticated have no SELECT grant on
   * it — see the column-grant block in supabase_migration_organisations.sql —
   * so it is absent from rows loaded through the public client. Present only
   * on rows loaded through the service-role client (admin panel).
   */
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

/** An organisation plus its joined relations, as the admin panel loads it. */
export interface OrganisationWithRelations extends Organisation {
  types: OrganisationType[];
  locations: OrganisationLocation[];
  links: OrganisationLink[];
  /** Directory artists attached to this organisation, with the role each holds. */
  artists: OrganisationArtist[];
}

/** One artist's association with an organisation, flattened for display. */
export interface OrganisationArtist {
  artist_id: string;
  artist_name: string;
  artist_status: ArtistStatus;
  role_key: string;
}

/** Just enough of an organisation to render a link to it. */
export interface OrganisationSummary {
  id: string;
  name: string;
}

/**
 * One organisation an artist is attached to, with the role held there.
 *
 * An artist can appear several times over with different roles — that is
 * the point of role_key being part of the primary key — so this is a flat
 * list that the pages group with groupByRole() in lib/organisations.ts.
 */
export interface ArtistOrganisationEntry {
  organisation: OrganisationSummary;
  role: OrganisationRole;
}

/**
 * One row of the forms' "Labels / crews" field.
 *
 * `id` is set when the typed text resolved to an approved organisation and
 * null when it didn't. The server re-checks the id before trusting it, and
 * holds unresolved names as flat text until an admin approves the artist —
 * see src/lib/organisation-writes.ts.
 */
export interface OrganisationFormRow {
  id: string | null;
  name: string;
}

/** The inverse: one artist attached to an organisation, with their role. */
export interface OrganisationArtistEntry {
  artist: { id: string; name: string };
  role: OrganisationRole;
}

/**
 * Everything the public /organisation/[id] page renders.
 *
 * `notes` is absent by construction — the public roles hold no SELECT grant
 * on that column, so it cannot be requested, let alone rendered.
 * `description` is likewise not fetched: the column exists but nothing
 * displays it yet.
 */
export interface OrganisationPage {
  id: string;
  name: string;
  status: OrganisationStatus;
  run_by_text: string | null;
  types: OrganisationType[];
  locations: OrganisationLocation[];
  links: OrganisationLink[];
  /** Approved artists only, one entry per role, sorted by artist name. */
  artists: OrganisationArtistEntry[];
}
