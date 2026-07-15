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
// sync-soundcloud.mjs for why that's a separate, async concern
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
  /** Registrable domains that mark an input as "a URL for this platform".
   *  Matched as an exact host or a subdomain suffix (so "bandcamp.com" also
   *  matches "foo.bandcamp.com" but not "notbandcamp.com"). */
  domainHints: string[];
  /** Loose validity check on the extracted handle — advisory, not enforced. */
  handlePattern: RegExp;
  buildUrl: (handle: string) => string;
  extractHandle: (url: URL) => string | null;
  /** Path prefixes whose query string is *content* (a search term), not a
   *  profile handle — e.g. "/search". A URL on one of these paths is kept as a
   *  search URL (see searchParams) instead of being rebuilt from a handle. */
  searchPaths?: string[];
  /** On a searchPaths URL, the query params to preserve (the actual search
   *  terms, e.g. ["q"]); every other param is dropped as tracking. */
  searchParams?: string[];
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
    // soundcloud.com/search?q=<artist> — kept for artists who only appear on
    // tracks, with no profile page of their own. Keep the query term, drop the
    // rest (SoundCloud appends tracking like ?ref=… to shared search links).
    searchPaths: ["/search"],
    searchParams: ["q"],
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
    domainHints: ["bandcamp.com"],
    handlePattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    // bandcamp.com/search?q=<artist> lives on the apex host (not an artist
    // subdomain). Keep the query term, drop tracking. The subdomain-based
    // extractHandle below is skipped for these by the search short-circuit.
    searchPaths: ["/search"],
    searchParams: ["q"],
    // Any /album/, /track/, /releases, /follow_me path is dropped
    // because the URL is rebuilt from the subdomain alone. No trailing
    // slash — resolveProfileLinkUrl strips them uniformly across every
    // platform so stored URLs are consistent.
    buildUrl: (h) => `https://${h.toLowerCase()}.bandcamp.com`,
    extractHandle: (u) => {
      // Strip a leading "www." first. Bandcamp serves every artist from a
      // bare subdomain (foo.bandcamp.com) and 301-redirects the www.
      // variant to it; "www" is never a real artist handle, and Firefox
      // flags the www. host as a potential security risk. Without this
      // strip the "www" would be kept as part of the subdomain and the
      // canonical URL would be rebuilt as https://www.foo.bandcamp.com.
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      const sub = host.replace(/\.bandcamp\.com$/, "");
      return sub !== host ? sub : null;
    },
  },
  resident_advisor: {
    // ra.co is current; residentadvisor.net is the pre-rebrand host. Old .net
    // URLs are accepted here and rebuilt onto ra.co by buildUrl (which always
    // emits the ra.co host from the extracted handle). See
    // canonicalizeResidentAdvisorUrl for the host-only rewrite used elsewhere.
    domainHints: ["ra.co", "residentadvisor.net"],
    // RA handles legitimately contain periods (e.g. "kali.", "j.aria",
    // "u.r.trax"), so periods are allowed — unlike a bare hyphen/alnum slug.
    handlePattern: /^[a-z0-9][a-z0-9._-]{1,59}$/i,
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

/**
 * Rewrites a pre-rebrand Resident Advisor URL (residentadvisor.net) onto the
 * current ra.co host, preserving the path/query/hash. Any other URL — already
 * ra.co, unparseable, or a different site — is returned unchanged. Pure host
 * swap with no path assumptions, so it's safe for ingestion and the backfill
 * to run over arbitrary RA URLs; the templated normalizer does a stricter
 * handle-based rebuild on top of this.
 */
export function canonicalizeResidentAdvisorUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "residentadvisor.net" && !host.endsWith(".residentadvisor.net")) {
    return url;
  }
  parsed.hostname = "ra.co";
  parsed.protocol = "https:";
  return parsed.toString();
}

/** Platforms this module can build/validate a URL for. Everything else
 *  (beatport, qobuz, discogs, homepage, "other", any admin-added
 *  category, ...) passes through unchanged. */
export function isTemplatedPlatform(platformKey: string): boolean {
  return platformKey in CONFIG;
}

/** True when `host` is exactly `domain` or a subdomain of it. Avoids the
 *  substring false-positives of host.includes() (e.g. "notbandcamp.com"
 *  must not match "bandcamp.com"). */
function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
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
  const matches = config.domainHints.some((domain) => hostMatchesDomain(host, domain));
  return matches ? parsed : null;
}

/** Rebuilds a search URL keeping only the allowlisted query params (the search
 *  terms) and dropping everything else (tracking). Forces https and drops the
 *  hash, matching the canonical no-cruft shape used for profile URLs. */
function cleanSearchUrl(url: URL, keepParams: string[]): string {
  const kept = new URLSearchParams();
  for (const key of keepParams) {
    const value = url.searchParams.get(key);
    if (value !== null) kept.set(key, value);
  }
  const query = kept.toString();
  const base = `https://${url.host}${url.pathname}`;
  return query ? `${base}?${query}` : base;
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

// ── Link-shim unwrapping ──────────────────────────────────────────
// Instagram and Facebook route outbound links through a redirect shim
// that carries the real destination in a ?u= query param, e.g.
//   https://l.instagram.com/?u=https%3A%2F%2Flinktr.ee%2Ffoo%3Futm...&e=...
// The destination is percent-encoded right there in the URL, so it can be
// expanded synchronously — no need to follow the redirect over the network
// the way on.soundcloud.com share links (resolveShareUrl) do.

/** Redirect-shim hosts that wrap a destination URL in a ?u= (or ?url=) param. */
const REDIRECT_WRAPPER_HOSTS = new Set([
  "l.instagram.com",
  "l.facebook.com",
  "lm.facebook.com",
]);

/**
 * If `input` is a known link-shim URL (l.instagram.com/?u=…), returns the
 * decoded destination it points to; otherwise returns the input unchanged.
 * Unwraps repeatedly (capped by `maxDepth`) in case a link is wrapped more
 * than once, and only trusts an http(s) destination. Purely synchronous — no
 * redirect is followed. Tracking params on the *destination* are left intact
 * for the normal cleaners (cleanLinkUrl / normalizeProfileLink) to strip.
 */
export function unwrapRedirectUrl(input: string, maxDepth = 5): string {
  let current = input.trim();
  for (let i = 0; i < maxDepth; i++) {
    const withScheme = /^https?:\/\//i.test(current) ? current : `https://${current}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      return current;
    }
    if (!REDIRECT_WRAPPER_HOSTS.has(parsed.hostname.toLowerCase())) return current;
    // URLSearchParams already percent-decodes the value.
    const target = parsed.searchParams.get("u") ?? parsed.searchParams.get("url");
    if (!target || !/^https?:\/\//i.test(target)) return current;
    current = target.trim();
  }
  return current;
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
        // https://ra.co/dj/handle (singular, current) or the legacy plural
        // /djs/handle. Old residentadvisor.net links use the singular form too.
        const match = parsed.pathname.match(/\/djs?\/([^/]+)/);
        return match ? match[1] : lastPathSegmentOfUrl(url);
      }

      case "bandcamp": {
        // https://handle.bandcamp.com — strip a leading "www." first; see
        // the note in CONFIG.bandcamp.extractHandle (www is never a real
        // handle and Firefox flags the www. host as a security risk).
        const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
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
  if (!trimmed) return { url: trimmed, handle: null, wasTransformed: false, warning: null };

  // Expand an Instagram/Facebook link-shim redirect (l.instagram.com/?u=…) up
  // front so the rest of the pipeline operates on the real destination URL.
  const unwrapped = unwrapRedirectUrl(trimmed);
  const passthrough: NormalizeResult = {
    url: unwrapped,
    handle: null,
    wasTransformed: unwrapped !== trimmed,
    warning: null,
  };

  const config = CONFIG[platformKey];
  if (!config) return passthrough;

  const withoutAt = unwrapped.replace(/^@/, "");

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
    // Search URLs (soundcloud.com/search?q=…, bandcamp.com/search?q=…) carry the
    // query as content, not a profile handle. Keep the search term(s), strip
    // tracking, and don't try to extract a handle or warn about a "home page".
    if (config.searchPaths?.some((p) => parsed.pathname.startsWith(p))) {
      const url = cleanSearchUrl(parsed, config.searchParams ?? []);
      return { url, handle: null, wasTransformed: url !== trimmed, warning: null };
    }

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

// Path prefixes whose query string is meaningful content (a search term,
// voucher code, …) rather than tracking, for NON-templated platforms cleaned
// generically below. Templated platforms (soundcloud, bandcamp) handle their
// own search URLs in normalizeProfileLink via CONFIG.searchPaths; they are
// listed here too so a direct cleanGenericUrl() call behaves identically.
const GENERIC_SEARCH_PATH_PREFIXES: Partial<Record<string, string>> = {
  soundcloud: "/search",
  discogs: "/search",
  youtube: "/results",
  bandcamp: "/search",
  venmo: "/code",
};

/**
 * Generic cleaner for platforms without a handle template: trims, then strips
 * everything from "?" onward (tracking params, share tokens), except on the
 * platform's search/content path where the whole query is kept intact. This is
 * the default fallback for resolveProfileLinkUrl's non-templated branch and the
 * single implementation behind lib/platforms.ts's cleanLinkUrl.
 */
export function cleanGenericUrl(platform: string, url: string): string {
  const trimmed = url.trim();
  const searchPrefix = GENERIC_SEARCH_PATH_PREFIXES[platform];
  if (searchPrefix) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.pathname.startsWith(searchPrefix)) return trimmed;
    } catch {
      // malformed URL — fall through to default stripping
    }
  }
  return trimmed.split("?")[0];
}

/**
 * Server-side convenience: resolves the URL to store for a link field.
 * Templated platforms get the full normalize/construct treatment; everything
 * else is run through cleanGenericUrl (overridable via `fallbackClean`). The
 * result is stripped of any trailing slash so stored URLs are consistent
 * across all platforms.
 */
export function resolveProfileLinkUrl(
  platformKey: string,
  rawInput: string,
  fallbackClean: (platform: string, url: string) => string = cleanGenericUrl
): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return trimmed;
  // Expand link-shim wrappers (l.instagram.com/?u=…) before cleaning so
  // non-templated platforms (e.g. linktree) resolve to the real destination
  // too. normalizeProfileLink unwraps internally, but the fallback cleaner
  // does not, so do it here for both branches.
  const unwrapped = unwrapRedirectUrl(trimmed);
  const resolved = isTemplatedPlatform(platformKey)
    ? normalizeProfileLink(platformKey, unwrapped).url
    : fallbackClean(platformKey, unwrapped);
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
  fallbackClean: (platform: string, url: string) => string = cleanGenericUrl
): Promise<string> {
  const trimmed = rawInput.trim();
  if (!trimmed) return trimmed;
  const expanded = platformKey === "soundcloud" ? await resolveShareUrl(trimmed) : trimmed;
  return resolveProfileLinkUrl(platformKey, expanded, fallbackClean);
}
