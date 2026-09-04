// ============================================================
// Network URL resolution: "where does this link ACTUALLY point?"
//
// Some links can't be canonicalized by string manipulation alone —
// their path is an opaque ID and the real destination is only knowable
// by following a redirect. SoundCloud's mobile share sheet hands out
// https://on.soundcloud.com/8KP9u6WaRSeo1ycHww; a Linktree page lists
// https://soundcloud.app.goo.gl/N1oiE; a HÖR bio carries a bit.ly.
// All three are the same problem.
//
// This module owns that problem and ONLY that problem. It answers
// "what URL does this redirect to", and stops there. Deciding which
// platform the result belongs to is classify-platform-url.ts; tidying
// it into the stored form is profile-links.ts. Callers run those
// afterwards. Keeping resolution separate from canonicalization is
// deliberate — the two were previously tangled together in two
// divergent copies (see "History" below), and re-merging them is how
// that drift starts again.
//
// SERVER ONLY. This module makes network calls, so it must never be
// imported from a client component. It deliberately does NOT live in
// profile-links.ts, which src/components/ProfileLinkField.tsx imports
// with "use client" — fetch code sitting in that module is one
// tree-shaking regression away from shipping to the browser.
//
// ------------------------------------------------------------
// History
//
// This replaces two independent redirect-followers that disagreed on
// nearly every detail:
//
//   - profile-links.ts resolveShareUrl — on.soundcloud.com only,
//     redirect:"follow", 5s, stripped the query, validated the
//     destination, returned the original on failure. Called from the
//     form save paths.
//   - integrate-harvested-links.mjs resolveShortLink — bit.ly only,
//     redirect:"manual", 8s, kept the query, did NOT validate the
//     destination, returned null on failure. Called from stage 2d.
//
// Two hosts covered between them. A census of all 200,127 live and
// 195,689 staged links on 2026-08-08 found fourteen distinct
// redirect-style hosts, most handled by neither — including 523
// staged on.soundcloud.com rows that the forms would have resolved
// but 2d never did. See documentation/URL-RESOLUTION-PLAN.md.
//
// ------------------------------------------------------------
// Why destination validation is mandatory
//
// Every host below was probed live on 2026-08-08, and "follow the
// redirect, keep whatever comes back" turned out to be WRONG for more
// than half of them:
//
//   spotify.link/eqRHE9U72Db  ->  spotify.app.link/eqRHE9U72Db?_p=...
//   vm.tiktok.com/ZSKeHLQN    ->  tiktok.com/?_r=1
//
// The first is a Branch deep link, the second is a bot-blocked bounce
// to the homepage. Both are strictly WORSE than the link we started
// with, and a resolver that trusted them would overwrite a real
// profile URL with a useless one. Each reproduced across three
// separate samples, so they're steady-state behaviour, not flukes.
//
// So Tier A hosts declare what a believable destination looks like,
// and anything else is treated as a failed resolve — the original
// link is kept. resolveShareUrl already worked this way ("only trust
// a redirect that actually landed on soundcloud.com"); this
// generalizes that posture to every host rather than relaxing it.
// ============================================================

/** Hosts whose true target needs a network round-trip, and what counts as a
 *  believable answer for each.
 *
 *  - "validate": the destination platform is known up front, so the resolved
 *    URL must look right or it's discarded. `expect` is the check.
 *  - "reclassify": a generic shortener. The destination is unknowable by
 *    nature, so anything that isn't an error is accepted and the caller
 *    re-runs classifyPlatformUrl on it. */
import { BOT_UA } from "./user-agent";

export type HostTier = "validate" | "reclassify";

interface HostRule {
  tier: HostTier;
  /** Only for "validate": does the final URL look like the profile we expected?
   *  Receives a parsed URL so rules can check the path, not just the host. */
  expect?: (destination: URL) => boolean;
  /** Human-readable expectation, used in failure reporting. */
  expectation?: string;
}

/** True when `host` is `domain` itself or a subdomain of it. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Keyed by the bare (www-stripped) hostname, matched EXACTLY. Exact matching
 *  is what keeps soundcloud.app.goo.gl, maps.app.goo.gl and goo.gl distinct —
 *  the first resolves to a SoundCloud profile, the second is a venue pin we
 *  don't want touched, and only the third is a general-purpose shortener. */
const RESOLVABLE_HOSTS: ReadonlyMap<string, HostRule> = new Map<string, HostRule>([
  // ---- Tier A: known destination, validated -------------------
  [
    "on.soundcloud.com",
    {
      tier: "validate",
      expect: (d) => hostMatches(d.hostname, "soundcloud.com") && d.hostname !== "on.soundcloud.com",
      expectation: "soundcloud.com",
    },
  ],
  [
    "soundcloud.app.goo.gl",
    {
      tier: "validate",
      expect: (d) => hostMatches(d.hostname, "soundcloud.com"),
      expectation: "soundcloud.com",
    },
  ],
  [
    "fb.me",
    {
      tier: "validate",
      expect: (d) => hostMatches(d.hostname, "facebook.com"),
      expectation: "facebook.com",
    },
  ],
  // spotify.link and vm.tiktok.com currently ALWAYS fail this check (see the
  // header). They stay listed on purpose: the validation is exactly what makes
  // them safe to attempt, and if either service starts answering bots properly
  // their rows resolve with no code change. Until then they're correctly left
  // alone rather than corrupted.
  [
    "spotify.link",
    {
      tier: "validate",
      expect: (d) => hostMatches(d.hostname, "spotify.com"),
      expectation: "open.spotify.com",
    },
  ],
  [
    "vm.tiktok.com",
    {
      tier: "validate",
      // The homepage bounce (tiktok.com/?_r=1) has an empty path, so requiring
      // a /@handle segment is what separates a real profile from the block.
      expect: (d) => hostMatches(d.hostname, "tiktok.com") && /^\/@[^/]+/.test(d.pathname),
      expectation: "tiktok.com/@handle",
    },
  ],

  // ---- Tier B: generic shorteners, destination unknown --------
  ["bit.ly", { tier: "reclassify" }],
  ["goo.gl", { tier: "reclassify" }],
  ["tinyurl.com", { tier: "reclassify" }],
  ["shorturl.at", { tier: "reclassify" }],
  ["cutt.ly", { tier: "reclassify" }],
  ["ow.ly", { tier: "reclassify" }],
  ["rb.gy", { tier: "reclassify" }],
  ["buff.ly", { tier: "reclassify" }],
]);

/** Tier C — deliberately NOT resolved. Documentation only; this map is never
 *  consulted at runtime. It exists so that a future reader who notices these
 *  hosts in the data can see they were considered and excluded, rather than
 *  assuming an oversight and adding them to RESOLVABLE_HOSTS. */
export const NOT_RESOLVED_HOSTS: ReadonlyMap<string, string> = new Map([
  [
    "lnk.to",
    "Music smart-link. Returns 200 at its own URL and fans out to many stores via JS — there is no single real target to resolve to.",
  ],
  ["ffm.to", "Music smart-link (Feature.fm). Same as lnk.to."],
  ["smarturl.it", "Music smart-link. Same as lnk.to."],
  ["hyperurl.co", "Music smart-link. Same as lnk.to."],
  [
    "youtu.be",
    "Deterministic (youtu.be/<id> -> youtube.com/watch?v=<id>), so no network call is warranted — and these are VIDEO links, not channels, so resolving one still wouldn't yield an artist profile. Separate data-model question.",
  ],
  [
    "maps.app.goo.gl",
    "A venue pin, not an artist link. Distinct from soundcloud.app.goo.gl, which is why host matching is exact.",
  ],
]);

export type ResolveFailureReason =
  /** Host isn't in RESOLVABLE_HOSTS — no network call was made. */
  | "not-resolvable"
  /** The host answered without a redirect. Common for smart-links. */
  | "no-redirect"
  /** Resolved, but the destination didn't match the Tier A expectation. */
  | "validation-failed"
  /** Resolved to a page that answered 4xx/5xx. */
  | "dead-destination"
  /** Still redirecting after maxHops. Likely a loop. */
  | "max-hops"
  /** Exceeded timeoutMs. */
  | "timeout"
  /** DNS failure, TLS error, connection refused, malformed Location, … */
  | "network-error";

export interface ResolveResult {
  /** The resolved URL on success; the ORIGINAL input on any failure. Callers
   *  can always store this value without checking `resolved` first. */
  url: string;
  /** Did the URL actually change? */
  resolved: boolean;
  /** Which tier the input host belongs to, or null if not resolvable. Module
   *  callers use this to decide whether to re-run platform classification:
   *  "reclassify" yes, "validate" no (the platform was already known). */
  tier: HostTier | null;
  /** The final URL reached, even when it was rejected. Null if no redirect was
   *  followed. Kept separate from `url` so failure reports can say what the
   *  link pointed at without that value ever being mistaken for a result. */
  destination: string | null;
  /** HTTP status at the destination, when a response was seen. */
  finalStatus: number | null;
  /** Absent on success. */
  reason?: ResolveFailureReason;
}

export interface ResolveOptions {
  /** Budget for the WHOLE resolve, across every hop — not per request. Keeps a
   *  redirect chain from multiplying the worst case. */
  timeoutMs?: number;
  maxHops?: number;
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_HOPS = 5;
const DEFAULT_USER_AGENT = BOT_UA;

/** Bare hostname (lowercased, www-stripped), or null if `input` isn't a URL. */
function bareHost(input: string): string | null {
  const withScheme = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True when this URL's real target needs a network round-trip. Cheap and
 *  synchronous — safe to use as a filter before deciding to resolve a batch. */
export function isResolvableHost(input: string): boolean {
  const host = bareHost(input);
  return host !== null && RESOLVABLE_HOSTS.has(host);
}

/** Every host this module knows how to resolve.
 *
 *  Exists so a caller scanning a large table can pre-filter in SQL instead of
 *  pulling every row and testing it in JS — artist_links holds 200k rows and
 *  fewer than a hundred of them are resolvable. A `url ILIKE %host%` filter
 *  built from this list is deliberately loose (it also matches
 *  maps.app.goo.gl); callers re-test survivors with isResolvableHost, which
 *  matches exactly. */
export function resolvableHosts(): string[] {
  return [...RESOLVABLE_HOSTS.keys()];
}

/** Which tier a URL's host belongs to, or null if it isn't resolvable. */
export function hostTier(input: string): HostTier | null {
  const host = bareHost(input);
  if (host === null) return null;
  return RESOLVABLE_HOSTS.get(host)?.tier ?? null;
}

/** What a Tier A host expects its destination to look like, for reporting.
 *  Null for Tier B (no expectation) and unknown hosts. */
export function hostExpectation(input: string): string | null {
  const host = bareHost(input);
  if (host === null) return null;
  return RESOLVABLE_HOSTS.get(host)?.expectation ?? null;
}

function failure(
  original: string,
  tier: HostTier | null,
  reason: ResolveFailureReason,
  destination: string | null = null,
  finalStatus: number | null = null
): ResolveResult {
  return { url: original, resolved: false, tier, destination, finalStatus, reason };
}

/**
 * Follows `url`'s redirect chain and returns where it really points.
 *
 * NEVER THROWS. Every failure — timeout, DNS error, redirect loop, a
 * destination that doesn't look like what the host promised — comes back as a
 * ResolveResult whose `url` is the unmodified input, so a caller can always
 * write `result.url` without a guard. That contract is what lets the form save
 * paths call this without risking a user's link being lost to a transient
 * network blip.
 *
 * Uses redirect:"manual" and reads the Location header rather than letting
 * fetch follow the chain itself, for two reasons: the destination page's body
 * is never downloaded, and each hop stays inspectable so the hop cap can't be
 * silently exceeded by the runtime's own limit.
 *
 * Does NOT strip query strings or canonicalize the result in any way — that's
 * profile-links.ts's job, and doing it here would be the start of a second
 * normalizer.
 *
 * Does NOT set an undici dispatcher. Scripts register the HTTP/1.1-only one
 * themselves via scripts/lib/http-dispatcher.mjs; the web app keeps Node's
 * default.
 */
export async function resolveRedirect(
  input: string,
  opts: ResolveOptions = {}
): Promise<ResolveResult> {
  const original = input.trim();
  const host = bareHost(original);
  const rule = host === null ? undefined : RESOLVABLE_HOSTS.get(host);
  if (!rule) return failure(original, null, "not-resolvable");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  // One controller for every hop, so timeoutMs bounds the whole operation
  // rather than each request within it.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const withScheme = /^https?:\/\//i.test(original) ? original : `https://${original}`;
  let current = withScheme;
  let finalStatus: number | null = null;
  // Counted rather than inferred from `current !== withScheme`, so a URL that
  // redirects to itself is reported as the loop it is instead of masquerading
  // as "this host never redirected".
  let hops = 0;

  try {
    while (hops < maxHops) {
      let res: Response;
      try {
        res = await fetchHop(current, controller.signal, userAgent);
      } catch {
        return failure(original, rule.tier, timedOut ? "timeout" : "network-error", null, null);
      }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          // A malformed or non-absolute-resolvable Location header.
          return failure(original, rule.tier, "network-error", null, res.status);
        }
        hops++;
        if (next === current) break; // self-redirect: a loop, not a destination
        current = next;
        continue;
      }

      // Not a redirect — this is the destination.
      finalStatus = res.status;
      break;
    }

    if (hops === 0) {
      // The host answered without redirecting at all. Smart-links do this:
      // they serve a JS landing page from their own URL.
      return failure(original, rule.tier, "no-redirect", null, finalStatus);
    }

    if (finalStatus === null) {
      // Still redirecting when the hop budget ran out, or looping.
      return failure(original, rule.tier, "max-hops", current, null);
    }

    if (finalStatus >= 400) {
      // The chain resolved, but the page it landed on is gone. Reported rather
      // than returned, so a backfill doesn't overwrite a live URL with a
      // known-dead one. (soundcloud.app.goo.gl/Hqa78gdDiUTcPHxc7 resolves
      // perfectly to soundcloud.com/ahuraaghabeigi, which 404s.)
      return failure(original, rule.tier, "dead-destination", current, finalStatus);
    }

    if (rule.tier === "validate") {
      let destination: URL;
      try {
        destination = new URL(current);
      } catch {
        return failure(original, rule.tier, "network-error", current, finalStatus);
      }
      if (!rule.expect || !rule.expect(destination)) {
        return failure(original, rule.tier, "validation-failed", current, finalStatus);
      }
    }

    return {
      url: current,
      resolved: true,
      tier: rule.tier,
      destination: current,
      finalStatus,
    };
  } catch {
    // Belt-and-braces: the never-throws contract must hold even if something
    // above is refactored into throwing.
    return failure(original, rule.tier, timedOut ? "timeout" : "network-error");
  } finally {
    clearTimeout(timer);
  }
}

/** One hop. HEAD first — it's cheapest and a redirect carries no body anyway —
 *  falling back to GET only when the host rejects the method outright. Any
 *  response body is discarded without being read. */
async function fetchHop(url: string, signal: AbortSignal, userAgent: string): Promise<Response> {
  const headers = { "User-Agent": userAgent };
  let res = await fetch(url, { method: "HEAD", redirect: "manual", signal, headers });

  // 405 Method Not Allowed / 501 Not Implemented mean "we don't do HEAD",
  // not "this link is broken" — retry those with GET before giving up.
  if (res.status === 405 || res.status === 501) {
    res.body?.cancel().catch(() => {});
    res = await fetch(url, { method: "GET", redirect: "manual", signal, headers });
  }

  // We only ever need status + headers. Cancelling frees the connection
  // instead of leaving an unread body pinning it open.
  res.body?.cancel().catch(() => {});
  return res;
}
