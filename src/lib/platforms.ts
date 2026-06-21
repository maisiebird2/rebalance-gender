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

/** Builds a generic profile-link placeholder for a form field. */
export function platformPlaceholder(label: string): string {
  return `https://... (${label})`;
}
