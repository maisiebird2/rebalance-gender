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

/**
 * Front-end overrides for the labels stored in the `platforms` table. The table
 * keeps the full name (still used in admin screens, e.g. missing-links), while
 * visitors see the shorter form on artist pages and in the submit/edit/revise
 * link fields — Resident Advisor is universally known as RA.
 */
const DISPLAY_LABEL_OVERRIDES: Record<string, string> = {
  resident_advisor: "RA",
};

/** The label a visitor sees for a platform (see DISPLAY_LABEL_OVERRIDES). */
export function platformDisplayLabel(platform: Platform): string {
  return DISPLAY_LABEL_OVERRIDES[platform.key] ?? platform.label;
}

/** Resolves a platform key (e.g. "soundcloud") to its display label. */
export function platformLabel(platforms: Platform[], key: string): string {
  const platform = platforms.find((p) => p.key === key);
  return platform ? platformDisplayLabel(platform) : key;
}

/**
 * The curated order platforms are presented in, everywhere a person sees a
 * list of them: the profile links on the public artist and organisation pages,
 * and the link fields in the submit/edit/revise forms.
 *
 * Deliberately NOT the `platforms.sort_order` column, which is a rough
 * historical grouping. `getPlatforms()` still returns rows in `sort_order` —
 * the admin screens use it, and it decides where a platform outside this list
 * sits in the forms (see sortPlatformsForForms).
 *
 * On the PUBLIC PAGES this list is also the allowlist: a platform absent from
 * it is not shown at all. Today that means Spotify, MusicBrainz and Last.fm —
 * directory data sources rather than links a visitor would want to click
 * through to (Last.fm's data was dropped outright, see
 * supabase_migration_remove_lastfm_data.sql, though existing links are
 * retained). A platform key added to the `platforms` table in future is hidden
 * until it is added here deliberately.
 *
 * The FORMS take only the order, never the allowlist: every platform stays
 * editable there, including the hidden ones, so an admin can still fix a wrong
 * Spotify link. Hidden links are also still used everywhere else — enrichment,
 * genre harvesting, admin QC.
 */
export const PLATFORM_DISPLAY_ORDER: readonly string[] = [
  "homepage",
  "soundcloud",
  "instagram",
  "linktree",
  "hoer",
  "youtube",
  "tiktok",
  "discogs",
  "bandcamp",
  "beatport",
  "qobuz",
  "resident_advisor",
  "apple_music",
  "tidal",
  "songkick",
  "facebook",
  "wikipedia",
  "1001tracklists",
  "djanes",
  "other",
];

const PLATFORM_DISPLAY_RANK: ReadonlyMap<string, number> = new Map(
  PLATFORM_DISPLAY_ORDER.map((key, i) => [key, i])
);

/** True when a platform's links are shown to visitors — see
 *  PLATFORM_DISPLAY_ORDER. */
export function isPlatformShownOnPublicPage(platform: string): boolean {
  return PLATFORM_DISPLAY_RANK.has(platform);
}

/**
 * Filters a page's profile links down to the ones a visitor should see —
 * dropping not-found rows, rows with no URL, and platforms outside
 * PLATFORM_DISPLAY_ORDER — and returns them in that order.
 *
 * Shared by the artist and organisation pages, which store their links in
 * separate tables but present them identically.
 */
export function visiblePublicLinks<
  T extends { platform: string; url: string | null; not_found?: boolean | null },
>(links: readonly T[] | null | undefined): T[] {
  return (links ?? [])
    .filter((l) => !l.not_found && l.url && isPlatformShownOnPublicPage(l.platform))
    .sort(
      (a, b) =>
        PLATFORM_DISPLAY_RANK.get(a.platform)! -
        PLATFORM_DISPLAY_RANK.get(b.platform)!
    );
}

/**
 * Orders the `platforms` rows for the grid of link fields in the submit, edit
 * and revise forms (and the admin organisation form) — see
 * ProfileLinksFieldset.
 *
 * PLATFORM_DISPLAY_ORDER first, so the fields sit in the same order a visitor
 * reads them on the artist page. Unlike the public pages, nothing is dropped:
 * a platform outside that list is still editable, appended after the ordered
 * ones in the `sort_order` sequence getPlatforms() returned it in.
 */
export function sortPlatformsForForms(platforms: readonly Platform[]): Platform[] {
  const rankOf = (p: Platform) =>
    PLATFORM_DISPLAY_RANK.get(p.key) ?? PLATFORM_DISPLAY_ORDER.length;
  // A stable sort (guaranteed since ES2019) keeps the unranked tail in the
  // order getPlatforms() supplied.
  return [...platforms].sort((a, b) => rankOf(a) - rankOf(b));
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
