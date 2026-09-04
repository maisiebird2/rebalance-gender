// ============================================================
// The site's canonical public origin, in one place.
//
// siteUrl() reads the env var when called, not when this module is
// imported: the scripts load .env.local after their imports have run, so
// a module-level constant would never see it. Call it after loadEnvLocal().
//
// Twin of src/lib/site-url.ts — keep the two in step.
// ============================================================

export const DEFAULT_SITE_URL = "https://allfrequencies.app";

/** NEXT_PUBLIC_SITE_URL, or the canonical origin, with no trailing slash. */
export function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
}
