// ============================================================
// Shared SoundCloud API client + URL helpers.
//
// The OAuth token flow and the authenticated GET wrapper were copied
// verbatim in both sync-soundcloud.mjs (Phase 2a — the directory sync)
// and build-soundcloud-follow-graph.mjs (Phase 7a — the non-directory
// follow-graph builder). This module is the single home for that
// shared fetch layer, plus the SoundCloud-URL helpers both scripts (or
// a future third caller) need. The design principle: this module knows
// how to TALK to SoundCloud and how to normalize SoundCloud URLs; each
// caller decides what to WRITE with the results.
//
// Networked bits live behind createSoundcloudClient() so the OAuth
// token state (and the per-run --debug flag) is captured per client
// instance rather than in module-level globals. Each script is its own
// process, so one client per run is the norm.
//
// Credentials (SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET) are
// read from process.env at token-fetch time — callers load .env.local
// themselves before creating a client. getAccessToken throws a clear
// error if they're missing (callers also do their own upfront check
// with a friendlier message).
// ============================================================

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// SoundCloud host matching — a stored `soundcloud` link whose domain
// isn't actually soundcloud.com (e.g. a Spotify URL saved in the wrong
// field) can never resolve. Callers use isSoundCloudUrl() as a cheap
// wrong-field guard before spending an API call.
// ------------------------------------------------------------
export const SOUNDCLOUD_HOST_REGEX = /(^|\.)soundcloud\.com$/i;

export function isSoundCloudUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return SOUNDCLOUD_HOST_REGEX.test(url.hostname.toLowerCase());
  } catch {
    return false; // unparseable — also treated as a mismatch
  }
}

// ------------------------------------------------------------
// SoundCloud CDN avatar URLs default to a 100×100 "-large" variant.
// Replacing the suffix with "-t500x500" gets the 500×500 version.
// Returns null for a missing/empty avatar.
// ------------------------------------------------------------
export function upgradeAvatarUrl(url) {
  if (typeof url !== "string" || !url) return null;
  return url.replace(/-large(\.\w+)$/, "-t500x500$1").replace(/-large$/, "-t500x500");
}

// ------------------------------------------------------------
// When a SoundCloud account has no real avatar, the API still returns an
// avatar_url — a generic grey placeholder hosted at
// .../images/default_avatar_<size>.png. It's not a usable profile photo,
// so callers should treat it as "no image" rather than re-hosting a
// silhouette. Matches any size variant / CDN host by the stable
// "default_avatar" filename (real avatars are avatars-<id>-<size>.jpg and
// never contain it). Returns false for a missing/empty avatar.
// ------------------------------------------------------------
export function isDefaultAvatarUrl(url) {
  return typeof url === "string" && /\/default_avatar[_.]/i.test(url);
}

// ------------------------------------------------------------
// Normalize a SoundCloud profile URL for in-memory dedupe-key matching
// (lowercased, query/hash stripped, trailing slash removed). Used by
// the follow-graph builder to tell whether a followed account is
// already in our DB. NOT the value written to the database — see
// cleanScUrl for that.
// ------------------------------------------------------------
export function normalizeScUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString().toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

// ------------------------------------------------------------
// Strip tracking query strings/fragments from a SoundCloud profile URL
// before it's written to artist_links, e.g.
//   https://soundcloud.com/damacha?utm_medium=api&utm_campaign=... -> https://soundcloud.com/damacha
// Unlike normalizeScUrl (used only for in-memory dedupe-key matching),
// this preserves the original case/trailing slash exactly as SoundCloud
// returned it, since this is the value that actually gets saved.
// ------------------------------------------------------------
export function cleanScUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

// ------------------------------------------------------------
// createSoundcloudClient — the authenticated API client. Encapsulates
// the OAuth Client Credentials token (fetched once, reused for the run,
// refreshed on 401) and the GET wrapper (timeout, 401 refresh, 429
// backoff). Returns { getAccessToken, soundcloudGet, resolveUser,
// getUserById, getFollowings }.
//
//   opts.debug — when true, logs raw request failures / rate-limit
//                backoffs (matches the old inline --debug behavior).
// ------------------------------------------------------------
export function createSoundcloudClient({ debug = false } = {}) {
  let cachedToken = null; // { accessToken, expiresAt }

  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
      return cachedToken.accessToken;
    }

    const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
    const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Missing SOUNDCLOUD_CLIENT_ID or SOUNDCLOUD_CLIENT_SECRET in the environment."
      );
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const res = await fetch("https://secure.soundcloud.com/oauth/token", {
      method: "POST",
      headers: {
        Accept: "application/json; charset=utf-8",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to get SoundCloud access token (HTTP ${res.status}): ${text}`);
    }

    const data = await res.json();
    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return cachedToken.accessToken;
  }

  // Authenticated GET. Accepts either a path+query (prefixed with
  // api.soundcloud.com) or a full URL — the latter is used for the
  // `next_href` pagination cursors SoundCloud returns as complete URLs
  // already pointing at api.soundcloud.com. Retries once on 401
  // (refreshes the token) and once on 429 (backs off, then retries).
  // Returns { ok, status, data }.
  async function soundcloudGet(pathQueryOrUrl, { retry = true } = {}) {
    const token = await getAccessToken();
    const url = pathQueryOrUrl.startsWith("http")
      ? pathQueryOrUrl
      : `https://api.soundcloud.com${pathQueryOrUrl}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json; charset=utf-8",
          Authorization: `OAuth ${token}`,
        },
      });

      if (res.status === 401 && retry) {
        await getAccessToken(true);
        return soundcloudGet(pathQueryOrUrl, { retry: false });
      }

      if (res.status === 429) {
        if (debug) console.log("  [debug] 429 rate limited, backing off 5s");
        await sleep(5000);
        if (retry) return soundcloudGet(pathQueryOrUrl, { retry: false });
        return { ok: false, status: 429, data: null };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, data: null };
      }

      const data = await res.json();
      return { ok: true, status: res.status, data };
    } catch (err) {
      if (debug) console.log(`  [debug] request failed: ${err?.message ?? err}`);
      return { ok: false, status: null, data: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  function resolveUser(scUrl) {
    return soundcloudGet(`/resolve?url=${encodeURIComponent(scUrl)}`);
  }

  // Fetch the same user resource resolveUser returns, but by the stable
  // numeric id (or urn) instead of the profile URL. Once an artist's id
  // has been stored (from a prior resolve), re-runs can call this and
  // skip /resolve entirely — one fewer thing to go wrong, and immune to
  // resolve failures when the artist later renames their profile URL
  // (the id never changes). Accepts a raw numeric id, a numeric string,
  // or a `soundcloud:users:<id>` urn — all valid path segments for
  // /users/{id}. Returns the same { ok, status, data } shape.
  function getUserById(idOrUrn) {
    return soundcloudGet(`/users/${encodeURIComponent(idOrUrn)}`);
  }

  // Fetch up to `cap` followings for a user, following the API's
  // linked_partitioning `next_href` cursor until exhausted or the cap
  // is hit. Returns { ok, users, truncated, lastStatus }.
  async function getFollowings(urn, cap) {
    const users = [];
    let nextUrl = `/users/${encodeURIComponent(urn)}/followings?limit=200&linked_partitioning=true`;
    let truncated = false;

    while (nextUrl && users.length < cap) {
      const res = await soundcloudGet(nextUrl);
      if (!res.ok || !res.data) {
        return { ok: users.length > 0, users, truncated: false, lastStatus: res.status };
      }

      const page = Array.isArray(res.data.collection) ? res.data.collection : [];
      for (const u of page) {
        users.push(u);
        if (users.length >= cap) {
          truncated = Boolean(res.data.next_href);
          break;
        }
      }

      nextUrl = users.length < cap ? res.data.next_href ?? null : null;
      if (nextUrl) await sleep(200);
    }

    return { ok: true, users, truncated, lastStatus: 200 };
  }

  return { getAccessToken, soundcloudGet, resolveUser, getUserById, getFollowings };
}
