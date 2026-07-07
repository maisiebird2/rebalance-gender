import type { ArtistWithRelations } from "@/lib/types";

/**
 * Merge the pared-down genre-options list with an artist's own saved genres,
 * de-duplicated and alphabetically sorted.
 *
 * Used by forms that are pre-populated from an existing artist (edit, revision).
 * The genre picker is a strict <select>, so any genre the artist already has
 * must appear in the options or it would render blank and be lost on save.
 * `getGenreOptions()` deliberately omits genres below the public threshold, so
 * we fold the artist's current genres back in here.
 *
 * Kept free of server-only imports so it is safe to call from client components.
 */
export function mergeGenreOptions(
  base: string[],
  artist: ArtistWithRelations,
): string[] {
  return Array.from(
    new Set([...base, ...(artist.genres ?? []).map((g) => g.name)]),
  ).sort((a, b) => a.localeCompare(b));
}
