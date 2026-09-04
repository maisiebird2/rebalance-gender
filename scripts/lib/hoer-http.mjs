// ============================================================
// HÖR REST client — the throttled, retrying HTTP layer shared by the
// library-driven HÖR sync scripts (harvest-hoer-library.mjs and, later,
// seed-hoer-terms.mjs / enrich-hoer-terms.mjs).
//
// hoer.live is a public WordPress site: its REST API and /artist/ pages
// need no token. We are a polite ~3 req/s guest — one shared throttle,
// a 20s timeout, and a single retry on 429/5xx.
//
// This module is the network layer, so it is NOT unit-tested; the pure,
// testable helpers live in hoer-library.mjs (the same split hoer-db.mjs /
// hoer-resolve.mjs use).
// ============================================================

import { BOT_UA } from "./user-agent.mjs";

export const HOER_ORIGIN = "https://hoer.live";

const UA = BOT_UA;
const THROTTLE_MS = 300;
const TIMEOUT_MS = 20000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single module-level throttle gate shared by every caller in the process.
let lastCall = 0;
async function throttle() {
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

// Throttled fetch with a timeout and one retry on 429/5xx. Returns the
// Response (callers read .ok / .status / .json() / .text()); never throws on
// an HTTP status, only on a network/timeout fault (the AbortController).
export async function hoerFetch(url, { retried = false } = {}) {
  await throttle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      redirect: "follow",
    });
    if ((res.status === 429 || res.status >= 500) && !retried) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "5", 10);
      await sleep(Math.min(retryAfter, 30) * 1000);
      return hoerFetch(url, { retried: true });
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch a WP REST endpoint and parse JSON. Returns { ok, status, data }.
//
// A 400 whose body code is an out-of-range page number is treated as "no
// more pages" (ok:true, data:[]) rather than an error, so a paginating
// caller can just loop until it sees an empty array — WordPress answers a
// page past the end with 400 invalid_page_number, not an empty 200.
//
// `pathAndQuery` is everything after the origin, e.g.
// "/wp-json/wp/v2/posts?per_page=100&page=2".
export async function hoerJson(pathAndQuery) {
  let res;
  try {
    res = await hoerFetch(`${HOER_ORIGIN}${pathAndQuery}`);
  } catch {
    return { ok: false, status: 0, data: null };
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const code = body?.code ?? "";
    if (/invalid_page_number|invalid_page/i.test(code)) return { ok: true, status: 400, data: [] };
    return { ok: false, status: 400, data: null };
  }
  if (!res.ok) return { ok: false, status: res.status, data: null };
  const data = await res.json().catch(() => null);
  return { ok: data != null, status: res.status, data };
}
