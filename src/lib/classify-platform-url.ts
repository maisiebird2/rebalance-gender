// ============================================================
// Platform classification: URL -> platform key.
//
// The single source of truth for "which platform is this link for?",
// shared by the web forms and every harvester script in scripts/.
//
// This replaces the per-script-copy convention those harvesters used to
// follow (each carried its own DOMAIN_PLATFORM_MAP). Seven near-identical
// copies meant the table drifted: the "youtube"/"facebook"/"tiktok" keys
// added 2026-07-03 landed in six of them and were missed in
// enrich-musicbrainz.mjs, which went on classifying those links as
// "other". One map, imported everywhere, is what stops that recurring.
//
// Harvesters still differ in legitimate ways — a harvester skips links
// back to its own source platform, HÖR skips YouTube (its set videos
// aren't an artist-channel signal), Linktree stages unknown domains under
// their bare domain instead of "other". Those differences are expressed
// as per-caller options here rather than as forked copies of the table.
//
// This module answers ONLY "which platform". Canonicalizing the URL for
// that platform (stripping tracking, trimming /watch and /@handle tabs,
// …) lives in profile-links.ts — call resolveProfileLinkUrl() after this.
// ============================================================

/** Domain -> platform key. Matched against the lowercased hostname as either
 *  an exact host or a subdomain of it, so "(^|\.)spotify\.com$" also covers
 *  open.spotify.com and "(^|\.)youtube\.com$" covers m./music.youtube.com. */
const DOMAIN_PLATFORM_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)soundcloud\.com$/i, "soundcloud"],
  [/(^|\.)instagram\.com$/i, "instagram"],
  [/(^|\.)spotify\.com$/i, "spotify"],
  [/(^|\.)spotify\.link$/i, "spotify"],
  [/(^|\.)youtube\.com$/i, "youtube"],
  [/(^|\.)youtu\.be$/i, "youtube"],
  [/(^|\.)residentadvisor\.net$/i, "resident_advisor"],
  [/(^|\.)ra\.co$/i, "resident_advisor"],
  [/(^|\.)bandcamp\.com$/i, "bandcamp"],
  [/(^|\.)facebook\.com$/i, "facebook"],
  [/(^|\.)fb\.me$/i, "facebook"],
  [/(^|\.)fb\.com$/i, "facebook"],
  [/(^|\.)tiktok\.com$/i, "tiktok"],
  [/(^|\.)linktr\.ee$/i, "linktree"],
  [/(^|\.)beatport\.com$/i, "beatport"],
  [/(^|\.)discogs\.com$/i, "discogs"],
  [/(^|\.)qobuz\.com$/i, "qobuz"],
  [/(^|\.)tidal\.com$/i, "tidal"],
  [/(^|\.)songkick\.com$/i, "songkick"],
  [/(^|\.)music\.apple\.com$/i, "apple_music"],
  [/(^|\.)itunes\.apple\.com$/i, "apple_music"],
  [/(^|\.)last\.fm$/i, "lastfm"],
  [/(^|\.)lastfm\.[a-z]+$/i, "lastfm"],
  [/(^|\.)musicbrainz\.org$/i, "musicbrainz"],
  [/(^|\.)wikipedia\.org$/i, "wikipedia"],
  // Mixcloud is a real music platform but deliberately NOT a tracked platform
  // key, so it lands in "other" by default. sync-linktree overrides it to a
  // bare "mixcloud" so those links stay staged rather than being promoted.
  [/(^|\.)mixcloud\.com$/i, "other"],
];

/** Hosts excluded for every caller, regardless of options. Twitter/X (and its
 *  t.co shortener) are excluded by project policy. */
const POLICY_SKIP_HOST_REGEXES: readonly RegExp[] = [
  /(^|\.)(twitter\.com|x\.com|t\.co)$/i,
];

/** What to return when no mapping matches: a fixed key, null to skip the link,
 *  or a function of the bare (www-stripped) hostname — sync-linktree uses the
 *  function form to stage unknown domains under the domain itself. */
export type ClassifyFallback = string | null | ((bareHost: string) => string | null);

export interface ClassifyOptions {
  /** Extra hosts to skip, on top of the policy list. Harvesters pass their own
   *  source platform here (a link back to it is a self-link, not a signal). */
  skip?: readonly RegExp[];
  /** Caller-specific mappings, tried BEFORE the shared table. */
  overrides?: ReadonlyArray<readonly [RegExp, string]>;
  /** Used when nothing matches. Defaults to "other". */
  fallback?: ClassifyFallback;
}

/** Hostname minus a leading "www.", lowercased. */
function bareDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Returns the platform key for `rawUrl`, or null when the link should be
 * skipped entirely (unparseable, a non-http(s) scheme like mailto:, or a
 * skip-listed host).
 *
 * Classification is host-based only — the path is never consulted — so it is
 * safe to call on any URL shape, including ones this codebase can't canonicalize.
 */
export function classifyPlatformUrl(rawUrl: string, opts: ClassifyOptions = {}): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // mailto:, tel:, javascript:, … are never platform links.
  if (!/^https?:$/.test(url.protocol)) return null;

  const host = url.hostname.toLowerCase();

  for (const re of POLICY_SKIP_HOST_REGEXES) if (re.test(host)) return null;
  for (const re of opts.skip ?? []) if (re.test(host)) return null;

  for (const [re, platform] of opts.overrides ?? []) if (re.test(host)) return platform;
  for (const [re, platform] of DOMAIN_PLATFORM_MAP) if (re.test(host)) return platform;

  const fallback = opts.fallback === undefined ? "other" : opts.fallback;
  return typeof fallback === "function" ? fallback(bareDomain(host)) : fallback;
}

// ── Per-harvester configurations ──────────────────────────────────
// Each harvester's deviation from the shared table, kept here beside the table
// itself so the differences are visible in one place instead of spread across
// seven scripts. Scripts import the config they need and pass it straight to
// classifyPlatformUrl().

/** A harvester skips links back to the platform it is harvesting FROM: those
 *  are self-links, already known, and not a signal worth storing. */
export const CLASSIFY_CONFIGS = {
  musicbrainz: {
    skip: [
      /(^|\.)musicbrainz\.org$/i, // self-reference
      /(^|\.)wikidata\.org$/i, // not a platform we track
    ],
  },
  harvested_links: {
    skip: [/(^|\.)soundcloud\.com$/i],
  },
  bandcamp: {
    skip: [/(^|\.)bandcamp\.com$/i],
  },
  soundcloud: {
    skip: [/(^|\.)soundcloud\.com$/i],
  },
  discogs: {
    skip: [
      /(^|\.)discogs\.com$/i,
      /(^|\.)wikidata\.org$/i, // future harvester source, not a platform
    ],
  },
  hoer: {
    skip: [
      /(^|\.)hoer\.(live|berlin)$/i, // self-links (identity link handled directly)
      /(^|\.)youtube\.com$/i, // HÖR set videos, not an artist-channel signal
      /(^|\.)youtu\.be$/i,
    ],
  },
  linktree: {
    skip: [/(^|\.)linktr\.ee$/i], // self-link
    // Mixcloud is retained under its own bare key rather than the promotable
    // "other" — see the map comment above.
    overrides: [[/(^|\.)mixcloud\.com$/i, "mixcloud"]] as ReadonlyArray<readonly [RegExp, string]>,
    // Unrecognized domains are staged under their bare domain (never "other"),
    // so they are retained without being promoted.
    fallback: (bareHost: string) => bareHost,
  },
} satisfies Record<string, ClassifyOptions>;
