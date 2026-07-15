// ============================================================
// Resident Advisor URL canonicalization (shared, scripts side).
//
// RA rebranded from residentadvisor.net to ra.co and changed its URL
// host; the path shape (/dj/<handle>) stayed the same. Old .net URLs
// keep turning up both in our stored data and in freshly ingested data,
// so this rewrites them onto ra.co in one place.
//
// This is the JavaScript mirror of canonicalizeResidentAdvisorUrl() in
// src/lib/profile-links.ts (used by the web forms). Keep the two in sync
// — the logic is intentionally identical: a pure host swap, preserving
// the path/query/hash, with no assumptions about the path. Any non-RA or
// unparseable URL is returned unchanged.
// ============================================================

/**
 * Rewrites a pre-rebrand residentadvisor.net URL onto ra.co, preserving the
 * rest of the URL. Returns any other URL (already ra.co, a different site, or
 * unparseable) unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
export function canonicalizeResidentAdvisorUrl(url) {
  let parsed;
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

/** True when `url`'s host is the pre-rebrand residentadvisor.net (any subdomain). */
export function isResidentAdvisorLegacyUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "residentadvisor.net" || host.endsWith(".residentadvisor.net");
}
