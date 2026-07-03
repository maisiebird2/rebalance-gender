import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "./types";

/**
 * Fetches every profile-link category from the `platforms` lookup
 * table (replaces the old hardcoded LINK_FIELDS/PLATFORM_LABELS
 * lists — see supabase_schema.sql "replace the link_platform enum"
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
 * Cleans a profile link URL before it is saved to the database.
 *
 * Always applied regardless of platform:
 * - Trims leading and trailing whitespace (including newlines and tabs).
 * - Strips everything from `?` onward (tracking params, share tokens, etc.).
 *
 * Platform-specific exceptions: certain URL paths use the query string as
 * meaningful content (search queries, voucher codes, etc.) rather than
 * tracking params. These are left intact.
 */

/** Path prefixes that signal the query string is content, not tracking. */
const SEARCH_PATH_PREFIXES: Partial<Record<string, string>> = {
  soundcloud: "/search",
  discogs:    "/search",
  youtube:    "/results",
  bandcamp:   "/search",
  venmo:      "/code",
};

export function cleanLinkUrl(platform: string, url: string): string {
  // Trim first so all downstream checks operate on a clean string.
  const trimmed = url.trim();

  const searchPrefix = SEARCH_PATH_PREFIXES[platform];
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
