import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "./types";
import { cleanGenericUrl } from "./profile-links";

/**
 * Fetches every profile-link category from the `platforms` lookup
 * table (replaces the old hardcoded LINK_FIELDS/PLATFORM_LABELS
 * lists — see the "replace the link_platform enum"
 * migration). Accepts either the anon or admin Supabase client since
 * `platforms` is publicly readable.
 */
export async function getPlatforms(client: SupabaseClient): Promise<Platform[]> {
  const { data, error } = await client
    .from("platforms")
    .select("*")
    .order("sort_order")
    .order("label");

  if (error) {
    console.error("getPlatforms error:", error);
    return [];
  }
  return data ?? [];
}

/** Resolves a platform key (e.g. "soundcloud") to its display label. */
export function platformLabel(platforms: Platform[], key: string): string {
  return platforms.find((p) => p.key === key)?.label ?? key;
}

/**
 * Builds a "search this platform for <artist>" URL from the platform's
 * `search_url_template` ({query} placeholder → URL-encoded artist name).
 * Returns null when the platform has no template.
 */
export function buildPlatformSearchUrl(
  platform: Platform,
  artistName: string
): string | null {
  if (!platform.search_url_template) return null;
  return platform.search_url_template.replace(
    "{query}",
    encodeURIComponent(artistName)
  );
}

/** Builds a generic profile-link placeholder for a form field. */
export function platformPlaceholder(label: string): string {
  return `https://... (${label})`;
}

/**
 * Cleans a profile link URL before it is saved to the database: trims, then
 * strips everything from `?` onward (tracking params, share tokens), except on
 * a platform's search/content path where the query is meaningful and kept.
 *
 * The implementation lives in lib/profile-links.ts (cleanGenericUrl) so there
 * is a single source of truth for URL cleaning; this is the historical name/
 * import site kept for the callers that already use it.
 */
export function cleanLinkUrl(platform: string, url: string): string {
  return cleanGenericUrl(platform, url);
}
