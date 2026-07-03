// ============================================================
// Per-platform artist search providers.
//
// SERVER-ONLY: several providers use secret API keys — never import
// this module from a client component. Client code should call the
// /api/admin/platform-search route instead.
//
// Used by the admin "Missing links" page (/admin/missing-links) to
// show the top few candidate profiles on an external platform for an
// artist that has no link there yet. Each provider takes an artist
// name and returns up to MAX_CANDIDATES candidates (best match
// first, in the platform's own relevance order).
//
// Adding a platform: write a `Provider` function, register it in
// PROVIDERS, and (if it needs credentials) gate it in
// `providerConfigured`. Platforms without a provider automatically
// fall back to a plain "search on <platform>" link in the UI, driven
// by platforms.search_url_template.
// ============================================================

export interface LinkCandidate {
  /** Display name of the profile on the external platform. */
  name: string;
  /** Canonical profile URL — what gets saved to artist_links. */
  url: string;
  /** Optional context to help disambiguate (location, listeners, ...). */
  detail: string | null;
}

type Provider = (artistName: string) => Promise<LinkCandidate[]>;

const MAX_CANDIDATES = 3;
const TIMEOUT_MS = 8000;

// MusicBrainz (and politeness elsewhere) requires an identifying UA.
const USER_AGENT = `RebalanceGenderDirectory/1.0 (${
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://rebalance-gender.app"
})`;

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  return res.json() as Promise<T>;
}

// ── Discogs ───────────────────────────────────────────────────────
// https://www.discogs.com/developers — database search requires auth:
// either a personal access token (DISCOGS_TOKEN) or an app's consumer
// key + secret (DISCOGS_CONSUMER_KEY / DISCOGS_CONSUMER_SECRET), both
// from discogs.com/settings/developers. Same rate limit either way;
// we don't need per-user OAuth, so whichever is configured works.

function discogsAuthHeader(): string | null {
  if (process.env.DISCOGS_TOKEN) {
    return `Discogs token=${process.env.DISCOGS_TOKEN}`;
  }
  if (process.env.DISCOGS_CONSUMER_KEY && process.env.DISCOGS_CONSUMER_SECRET) {
    return `Discogs key=${process.env.DISCOGS_CONSUMER_KEY}, secret=${process.env.DISCOGS_CONSUMER_SECRET}`;
  }
  return null;
}

interface DiscogsSearchResponse {
  results?: Array<{ id: number; title: string; uri?: string }>;
}

const searchDiscogs: Provider = async (name) => {
  const params = new URLSearchParams({
    q: name,
    type: "artist",
    per_page: String(MAX_CANDIDATES),
  });
  const data = await fetchJson<DiscogsSearchResponse>(
    `https://api.discogs.com/database/search?${params}`,
    { headers: { Authorization: discogsAuthHeader()! } }
  );
  return (data.results ?? []).slice(0, MAX_CANDIDATES).map((r) => ({
    name: r.title,
    url: r.uri
      ? `https://www.discogs.com${r.uri}`
      : `https://www.discogs.com/artist/${r.id}`,
    detail: null,
  }));
};

// ── MusicBrainz ───────────────────────────────────────────────────
// No key needed; identifying User-Agent is mandatory. Rate limit is
// 1 req/s — the footer component staggers its requests accordingly.

interface MusicBrainzSearchResponse {
  artists?: Array<{
    id: string;
    name: string;
    disambiguation?: string;
    area?: { name?: string };
  }>;
}

const searchMusicBrainz: Provider = async (name) => {
  // Quote the name so Lucene operators in artist names ("AND", "+",
  // parens...) are treated literally.
  const query = `artist:"${name.replace(/"/g, '\\"')}"`;
  const params = new URLSearchParams({
    query,
    fmt: "json",
    limit: String(MAX_CANDIDATES),
  });
  const data = await fetchJson<MusicBrainzSearchResponse>(
    `https://musicbrainz.org/ws/2/artist?${params}`
  );
  return (data.artists ?? []).slice(0, MAX_CANDIDATES).map((a) => ({
    name: a.name,
    url: `https://musicbrainz.org/artist/${a.id}`,
    detail:
      [a.disambiguation, a.area?.name].filter(Boolean).join(" · ") || null,
  }));
};

// ── Last.fm ───────────────────────────────────────────────────────

interface LastfmSearchResponse {
  results?: {
    artistmatches?: {
      artist?: Array<{ name: string; url: string; listeners?: string }>;
    };
  };
}

const searchLastfm: Provider = async (name) => {
  const params = new URLSearchParams({
    method: "artist.search",
    artist: name,
    api_key: process.env.LASTFM_API_KEY!,
    format: "json",
    limit: String(MAX_CANDIDATES),
  });
  const data = await fetchJson<LastfmSearchResponse>(
    `https://ws.audioscrobbler.com/2.0/?${params}`
  );
  const artists = data.results?.artistmatches?.artist ?? [];
  return artists.slice(0, MAX_CANDIDATES).map((a) => ({
    name: a.name,
    url: a.url,
    detail: a.listeners
      ? `${Number(a.listeners).toLocaleString()} listeners`
      : null,
  }));
};

// ── Spotify ───────────────────────────────────────────────────────
// Client-credentials flow; token cached module-level until expiry.

interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
}

interface SpotifySearchResponse {
  artists?: {
    items?: Array<{
      id: string;
      name: string;
      external_urls?: { spotify?: string };
      followers?: { total?: number };
      genres?: string[];
    }>;
  };
}

let spotifyToken: { value: string; expiresAt: number } | null = null;

async function getSpotifyToken(): Promise<string> {
  if (spotifyToken && Date.now() < spotifyToken.expiresAt) {
    return spotifyToken.value;
  }
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");
  const data = await fetchJson<SpotifyTokenResponse>(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }
  );
  spotifyToken = {
    value: data.access_token,
    // Refresh a minute early.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return spotifyToken.value;
}

const searchSpotify: Provider = async (name) => {
  const token = await getSpotifyToken();
  const params = new URLSearchParams({
    q: name,
    type: "artist",
    limit: String(MAX_CANDIDATES),
  });
  const data = await fetchJson<SpotifySearchResponse>(
    `https://api.spotify.com/v1/search?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return (data.artists?.items ?? []).slice(0, MAX_CANDIDATES).map((a) => ({
    name: a.name,
    url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`,
    detail:
      [
        a.genres?.slice(0, 2).join(", "),
        a.followers?.total != null
          ? `${Number(a.followers.total).toLocaleString()} followers`
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
  }));
};

// ── Bandcamp ──────────────────────────────────────────────────────
// No official API; this is the public autocomplete endpoint the
// bandcamp.com search box itself uses (search_filter "b" = bands).
// Being unofficial it may change shape — parse defensively.

interface BandcampSearchResponse {
  auto?: {
    results?: Array<{
      type?: string;
      name?: string;
      item_url_root?: string;
      url?: string;
      location?: string;
    }>;
  };
}

const searchBandcamp: Provider = async (name) => {
  const data = await fetchJson<BandcampSearchResponse>(
    "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search_text: name,
        search_filter: "b",
        full_page: false,
        fan_id: null,
      }),
    }
  );
  const results = data.auto?.results ?? [];
  return results
    .filter((r) => r.type === "b" && (r.item_url_root || r.url))
    .slice(0, MAX_CANDIDATES)
    .map((r) => ({
      name: r.name ?? "(unnamed)",
      url: (r.item_url_root ?? r.url)!,
      detail: r.location || null,
    }));
};

// ── Registry ──────────────────────────────────────────────────────

const PROVIDERS: Record<string, Provider> = {
  discogs: searchDiscogs,
  musicbrainz: searchMusicBrainz,
  lastfm: searchLastfm,
  spotify: searchSpotify,
  bandcamp: searchBandcamp,
};

/** Whether the provider's required credentials are present in the env. */
function providerConfigured(platform: string): boolean {
  switch (platform) {
    case "discogs":
      return discogsAuthHeader() !== null;
    case "lastfm":
      return Boolean(process.env.LASTFM_API_KEY);
    case "spotify":
      return Boolean(
        process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET
      );
    default:
      return true; // musicbrainz, bandcamp need no credentials
  }
}

/** True if inline top-N results can be fetched for this platform. */
export function hasSearchProvider(platform: string): boolean {
  return platform in PROVIDERS && providerConfigured(platform);
}

/**
 * Fetch the top candidate profiles on `platform` for `artistName`.
 * Throws on network/API errors (callers surface the message); returns
 * [] when the platform has no matches.
 */
export async function searchPlatformForArtist(
  platform: string,
  artistName: string
): Promise<LinkCandidate[]> {
  const provider = PROVIDERS[platform];
  if (!provider) throw new Error(`No search provider for "${platform}"`);
  if (!providerConfigured(platform)) {
    throw new Error(`Search provider for "${platform}" is not configured`);
  }
  return provider(artistName);
}
