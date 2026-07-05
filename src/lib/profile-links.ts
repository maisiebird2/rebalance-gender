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
    // No trailing slash — resolveProfileLinkUrl strips them uniformly
    // across every platform so stored URLs are consistent.
    buildUrl: (h) => `https://www.instagram.com/${h}`,
    extractHandle: (u) => lastPathSegment(u.pathname),
  },
  bandcamp: {
    domainHints: [".bandcamp.com"],
    handlePattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    // Any /album/, /track/, /releases, /follow_me path is dropped
    // because the URL is rebuilt from the subdomain alone. No trailing
    // slash — resolveProfileLinkUrl strips them uniformly across every
    // platform so stored URLs are consistent.
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

  // A SoundCloud mobile share link (on.soundcloud.com/<id>) only resolves to a
  // real profile by following its redirect — an async, network-bound step
  // handled by resolveShareUrl() on the server save paths. If one reaches this
  // synchronous normalizer (the resolve step was skipped, or its fetch failed),
  // do NOT run the extract logic below: on.soundcloud.com matches the
  // soundcloud domain hint, so extractHandle would turn the opaque share ID
  // into a bogus https://soundcloud.com/<id>. Pass it through untouched so the
  // original share link is preserved instead.
  if (platformKey === "soundcloud" && isSoundcloudShareLink(withoutAt)) {
    return passthrough;
  }

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
 * Removes any trailing slash(es) so every stored platform URL follows a
 * single, consistent no-trailing-slash convention — regardless of whether
 * it came from a templated buildUrl or the fallback cleaner, and whether the
 * user pasted one with or without a slash. A query/hash-only tail is left
 * alone (the save-path cleaners already strip query strings for these
 * platforms, so in practice the tail is a plain path). A bare-domain URL
 * loses its root slash too (https://x.bandcamp.com/ -> https://x.bandcamp.com),
 * which is still a valid, canonical URL.
 */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Server-side convenience: resolves the URL to store for a link field.
 * Templated platforms get the full normalize/construct treatment;
 * everything else falls back to the caller's existing cleaner (e.g.
 * cleanLinkUrl from lib/platforms.ts). The result is then stripped of any
 * trailing slash so stored URLs are consistent across all platforms.
 */
export function resolveProfileLinkUrl(
  platformKey: string,
  rawInput: string,
  fallbackClean: (platform: string, url: string) => string
): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return trimmed;
  const resolved = isTemplatedPlatform(platformKey)
    ? normalizeProfileLink(platformKey, trimmed).url
    : fallbackClean(platformKey, trimmed);
  return stripTrailingSlash(resolved);
}

// ============================================================
// Mobile share-link resolution (async, server-side only)
//
// SoundCloud's mobile "share" sheet hands out links like
// https://on.soundcloud.com/8KP9u6WaRSeo1ycHww — the path is an opaque
// ID, not a handle, and the real profile URL is only knowable by
// following the redirect. That's a network round-trip, so unlike the
// rest of this module it can't be done synchronously in the client
// field's blur handler. It runs on the server save paths instead,
// BEFORE the synchronous normalize/extract step.
// ============================================================

/** Hosts used by SoundCloud's mobile share sheet. They 30x-redirect to the
 *  canonical https://soundcloud.com/<artist>... URL. */
const SOUNDCLOUD_SHARE_HOSTS = new Set(["on.soundcloud.com"]);

/** How long to wait on the redirect-follow before giving up and keeping the
 *  original link. Kept short so a slow/hung request can't stall a submission. */
const SHARE_RESOLVE_TIMEOUT_MS = 5000;

function hostnameOf(input: string): string | null {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `input` is a SoundCloud mobile share link (on.soundcloud.com/...).
 *  Used by normalizeProfileLink to leave such links untouched if they reach the
 *  sync path unresolved. */
export function isSoundcloudShareLink(input: string): boolean {
  const host = hostnameOf(input.trim());
  return host !== null && SOUNDCLOUD_SHARE_HOSTS.has(host);
}

/**
 * Expands a SoundCloud mobile share link to the canonical profile URL it
 * redirects to. Network-bound, so async and server-only — never call from a
 * client/sync context.
 *
 * Behavior:
 *   - Non-share input is returned unchanged with NO network call.
 *   - On success, returns the redirect's final URL with its query string
 *     stripped (normalizeProfileLink canonicalizes the path afterwards).
 *   - On ANY failure — network error, timeout, non-2xx, or a redirect that
 *     doesn't land on soundcloud.com — returns the ORIGINAL input unchanged,
 *     so the caller stores the share link as-is rather than losing it.
 */
export async function resolveShareUrl(rawInput: string): Promise<string> {
  const trimmed = rawInput.trim();
  if (!trimmed) return trimmed;

  const host = hostnameOf(trimmed);
  if (host === null || !SOUNDCLOUD_SHARE_HOSTS.has(host)) return trimmed;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHARE_RESOLVE_TIMEOUT_MS);
  try {
    // `redirect: "follow"` + response.url gives the final destination after the
    // share host's hops. HEAD is cheap; some hosts reject it, so fall back to
    // GET. We only read the resolved URL, never the body.
    let res = await fetch(withScheme, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok || !res.url) {
      res = await fetch(withScheme, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    }

    const resolvedHost = res.url ? hostnameOf(res.url) : null;
    // Only trust a redirect that actually landed on a soundcloud.com profile
    // (and not back on a share host). Anything else → keep the original.
    if (
      !res.ok ||
      resolvedHost === null ||
      !resolvedHost.endsWith("soundcloud.com") ||
      SOUNDCLOUD_SHARE_HOSTS.has(resolvedHost)
    ) {
      return trimmed;
    }
    return res.url.split("?")[0];
  } catch {
    return trimmed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Async sibling of resolveProfileLinkUrl for server-side save paths. Runs the
 * network resolve step FIRST (expanding SoundCloud mobile share links), then
 * applies the same synchronous normalization. If the resolve step fails the
 * original input flows through unchanged (and normalizeProfileLink leaves an
 * unresolved on.soundcloud.com link alone). Only SoundCloud incurs a possible
 * network call; every other platform is a plain sync passthrough.
 */
export async function resolveProfileLinkUrlAsync(
  platformKey: string,
  rawInput: string,
  fallbackClean: (platform: string, url: string) => string
): Promise<string> {
  const trimmed = rawInput.trim();
  if (!trimmed) return trimmed;
  const expanded = platformKey === "soundcloud" ? await resolveShareUrl(trimmed) : trimmed;
  return resolveProfileLinkUrl(platformKey, expanded, fallbackClean);
}
