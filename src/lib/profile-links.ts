// ============================================================
// Profile link normalization + validation.
//
// Lets someone paste a bare handle (e.g. "techno_blondy") or a full
// profile URL in any common shape — with/without https://, with/
// without www., with tracking query params, a mobile share link,
// etc. — into a link field, and converts it into the platform's
// canonical URL.
//
// Only implemented for platforms where a bare handle is enough to
// build a working URL on its own: soundcloud, instagram, bandcamp,
// resident_advisor. Platforms like beatport/qobuz/discogs embed a
// numeric ID in their URLs that can't be guessed from a handle, so
// those pass through unchanged here — cleanLinkUrl() in
// lib/platforms.ts still trims/strips tracking params for them, same
// as before this module existed.
//
// This module only checks that input *looks like* a handle/URL for
// the right platform (syntax). It does not check that the resulting
// URL actually resolves to a real profile — see project notes on
// enrich-soundcloud.mjs for why that's a separate, async concern
// (checking resolvability is still an open TODO).
// ============================================================

export interface NormalizeResult {
  /** Final value to use. Equal to the trimmed input if the platform
   *  isn't templated, or nothing needed to change. */
  url: string;
  /** Best-guess handle pulled out of the input, or null if none found. */
  handle: string | null;
  /** True if `url` differs from the trimmed input. */
  wasTransformed: boolean;
  /** Set when the input couldn't be confidently read as a handle for
   *  this platform, or doesn't match its usual format. Advisory only —
   *  callers should show it as a warning, not block on it, since a
   *  handful of real handles will legitimately fall outside the regex
   *  (new username rules, unicode, etc). */
  warning: string | null;
}

interface PlatformLinkConfig {
  /** Substrings that mark an input as "already a URL for this platform". */
  domainHints: string[];
  /** Loose sanity check on the extracted handle — advisory, not enforced. */
  handlePattern: RegExp;
  buildUrl: (handle: string) => string;
  extractHandle: (url: URL) => string | null;
}

function lastPathSegment(pathname: string): string | null {
  const parts = pathname.split("/").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const CONFIG: Record<string, PlatformLinkConfig> = {
  soundcloud: {
    domainHints: ["soundcloud.com"],
    handlePattern: /^[a-zA-Z0-9_-]{2,50}$/,
    buildUrl: (h) => `https://soundcloud.com/${h}`,
    extractHandle: (u) => lastPathSegment(u.pathname),
  },
  instagram: {
    domainHints: ["instagram.com"],
    // 1-30 chars, letters/digits/periods/underscores, no "..".
    handlePattern: /^(?!.*\.\.)[a-zA-Z0-9._]{1,30}$/,
    buildUrl: (h) => `https://www.instagram.com/${h}/`,
    extractHandle: (u) => lastPathSegment(u.pathname),
  },
  bandcamp: {
    domainHints: [".bandcamp.com"],
    handlePattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    buildUrl: (h) => `https://${h.toLowerCase()}.bandcamp.com`,
    extractHandle: (u) => {
      const host = u.hostname.toLowerCase();
      const sub = host.replace(/\.bandcamp\.com$/, "");
      return sub !== host ? sub : null;
    },
  },
  resident_advisor: {
    domainHints: ["ra.co"],
    handlePattern: /^[a-z0-9-]{2,60}$/i,
    buildUrl: (h) => `https://ra.co/dj/${h}`,
    extractHandle: (u) => {
      // Current RA URLs are /dj/handle (singular). Also accept the
      // legacy/plural /djs/handle some old links use, falling back to
      // the last path segment for anything else.
      const match = u.pathname.match(/\/djs?\/([^/]+)/);
      return match ? match[1] : lastPathSegment(u.pathname);
    },
  },
};

/** Platforms this module can build/validate a URL for. Everything else
 *  (beatport, qobuz, discogs, homepage, "other", any admin-added
 *  category, ...) passes through unchanged. */
export function isTemplatedPlatform(platformKey: string): boolean {
  return platformKey in CONFIG;
}

/** Tries to read `input` as a URL belonging to this platform (adding a
 *  https:// scheme if missing). Returns null if it's not parseable as a
 *  URL at all, or parses fine but the host doesn't match the platform. */
function tryParseAsPlatformUrl(input: string, config: PlatformLinkConfig): URL | null {
  const hasScheme = /^https?:\/\//i.test(input);
  const candidate = hasScheme ? input : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const matches = config.domainHints.some((hint) => host.includes(hint));
  return matches ? parsed : null;
}

/** Loose check for "this input is shaped like *some* URL", used only to
 *  distinguish "wrong-platform link" from "bare handle" when the input
 *  doesn't parse against the current platform's domain. */
function looksUrlShaped(input: string): boolean {
  return (
    /^https?:\/\//i.test(input) ||
    /^www\.[^/\s]+\.[a-z]{2,}/i.test(input) ||
    /^[^/\s]+\.[a-z]{2,}\//i.test(input)
  );
}

// ── Handle derivation ─────────────────────────────────────────────
// Derives a handle from a profile URL following the same conventions
// used in the migration scripts (add-beatport-links.mjs, enrich-bios.mjs).
// Moved here from app/artist/[id]/edit/actions.ts so other save paths
// (e.g. /admin/missing-links) can share it.

/** Last non-empty path segment of a full URL, or null. */
function lastPathSegmentOfUrl(url: string): string | null {
  try {
    return lastPathSegment(new URL(url).pathname);
  } catch {
    return null;
  }
}

export function deriveHandle(platform: string, url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);

    switch (platform) {
      case "soundcloud":
      case "instagram":
      case "discogs":
        // https://soundcloud.com/handle
        // https://www.instagram.com/handle/
        // https://www.discogs.com/artist/Handle  (last segment)
        return lastPathSegmentOfUrl(url);

      case "resident_advisor": {
        // https://ra.co/djs/handle
        const match = parsed.pathname.match(/\/djs\/([^/]+)/);
        return match ? match[1] : lastPathSegmentOfUrl(url);
      }

      case "bandcamp": {
        // https://handle.bandcamp.com
        const host = parsed.hostname.toLowerCase();
        const sub = host.replace(/\.bandcamp\.com$/, "");
        return sub !== host ? sub : null;
      }

      case "beatport": {
        // https://www.beatport.com/artist/slug/12345
        // handle = slug between "artist/" and the final numeric segment
        const afterArtist = url.split("artist/")[1];
        if (!afterArtist) return null;
        const withoutQuery = afterArtist.split(/[?#]/)[0];
        const trimmed = withoutQuery.replace(/\/+$/, "");
        const lastSlash = trimmed.lastIndexOf("/");
        return lastSlash === -1 ? trimmed : trimmed.slice(0, lastSlash) || null;
      }

      case "qobuz":
        // https://www.qobuz.com/us-en/interpreter/artist-slug/id
        // second-to-last segment is the slug
        try {
          const parts = new URL(url).pathname
            .split("/")
            .filter(Boolean);
          return parts.length >= 2 ? (parts.at(-2) ?? null) : null;
        } catch {
          return null;
        }

      case "other":
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function normalizeProfileLink(platformKey: string, rawInput: string): NormalizeResult {
  const trimmed = rawInput.trim();
  const passthrough: NormalizeResult = { url: trimmed, handle: null, wasTransformed: false, warning: null };
  if (!trimmed) return passthrough;

  const config = CONFIG[platformKey];
  if (!config) return passthrough;

  const withoutAt = trimmed.replace(/^@/, "");

  const parsed = tryParseAsPlatformUrl(withoutAt, config);

  if (parsed) {
    const handle = config.extractHandle(parsed);
    if (!handle) {
      return {
        ...passthrough,
        warning: "Couldn't find a handle in that link — check it's a profile page, not a search or home page.",
      };
    }
    const url = config.buildUrl(handle);
    return {
      url,
      handle,
      wasTransformed: url !== trimmed,
      warning: config.handlePattern.test(handle)
        ? null
        : `"${handle}" doesn't look like a typical handle for this platform — double-check it's correct.`,
    };
  }

  if (looksUrlShaped(withoutAt)) {
    // It's a URL, just not one whose host matches this platform.
    return {
      ...passthrough,
      warning: "This looks like a link to a different site — double-check you're in the right field.",
    };
  }

  // Bare handle.
  const handle = withoutAt.replace(/\/+$/, "");
  const url = config.buildUrl(handle);
  return {
    url,
    handle,
    wasTransformed: true,
    warning: config.handlePattern.test(handle)
      ? null
      : `"${handle}" doesn't look like a typical handle for this platform — double-check it's correct.`,
  };
}

/**
 * Server-side convenience: resolves the URL to store for a link field.
 * Templated platforms get the full normalize/construct treatment;
 * everything else falls back to the caller's existing cleaner (e.g.
 * cleanLinkUrl from lib/platforms.ts), unchanged from prior behavior.
 */
export function resolveProfileLinkUrl(
  platformKey: string,
  rawInput: string,
  fallbackClean: (platform: string, url: string) => string
): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return trimmed;
  if (!isTemplatedPlatform(platformKey)) return fallbackClean(platformKey, trimmed);
  return normalizeProfileLink(platformKey, trimmed).url;
}
