/**
 * lib/site-url.ts
 *
 * The site's canonical public origin, in one place. Read through a function
 * rather than a module-level constant so that a caller which loads .env.local
 * after its imports still sees the variable; the scripts do exactly that.
 * The scripts' twin is scripts/lib/site-url.mjs; keep the two in step.
 *
 * src/lib/email.ts deliberately does not use this: its fallback is
 * localhost, so a misconfigured dev box can never send production links.
 */

export const DEFAULT_SITE_URL = "https://allfrequencies.app";

/** NEXT_PUBLIC_SITE_URL, or the canonical origin, with no trailing slash. */
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
}
