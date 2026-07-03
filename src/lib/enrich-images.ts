// Single-artist image enrichment — shared logic used by:
//   - scripts/enrich-images.ts  (bulk CLI)
//   - src/app/admin/actions.ts  (quickApprove)
//   - src/app/artist/[id]/edit/actions.ts  (saveArtist, when new image-capable links are added)
//
// Given an artist ID, looks at their linked profiles in priority order,
// fetches each page, and pulls the og:image meta tag as a profile photo.
// Writes profile_image_url, profile_image_source, and
// profile_image_fetched_at back to the artists row on success.

import type { SupabaseClient } from "@supabase/supabase-js";

// Platform priority: try these link types in this order.
export const PLATFORM_PRIORITY = [
  "soundcloud",
  "bandcamp",
  "resident_advisor",
  "discogs",
  "beatport",
  "qobuz",
  "lastfm",
  "spotify",
  "wikipedia",
  "apple_music",
  "youtube",
  "other",
] as const;

export async function fetchOgImage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +profile picture enrichment)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    if (!res.ok) return null;

    // Only read the <head> — og:image is always there, and pages can be huge.
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      while (html.length < 200_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }

    const metaRegex =
      /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i;

    const match = html.match(metaRegex);
    const imageUrl = match?.[1] || match?.[2];
    if (!imageUrl) return null;

    return new URL(imageUrl, url).toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a profile image for a single artist and write it to the DB.
 *
 * Skips artists that already have a profile_image_url unless `force` is true.
 * Returns true if an image was found and saved, false otherwise.
 */
export async function enrichArtistImage(
  artistId: string,
  adminClient: SupabaseClient,
  { force = false }: { force?: boolean } = {}
): Promise<boolean> {
  // Fetch the artist + their links.
  const query = adminClient
    .from("artists")
    .select("id, name, profile_image_url, links:artist_links(platform, url)")
    .eq("id", artistId)
    .single();

  const { data: artist, error } = await query;
  if (error || !artist) {
    console.error(`[enrich-images] Failed to fetch artist ${artistId}:`, error?.message);
    return false;
  }

  // Skip if already has an image (unless forcing).
  if (!force && artist.profile_image_url) {
    return false;
  }

  const linksByPlatform = new Map(
    ((artist.links ?? []) as { platform: string; url: string }[]).map((l) => [l.platform, l.url])
  );

  const candidates = PLATFORM_PRIORITY.filter((p) => linksByPlatform.has(p));
  if (candidates.length === 0) {
    console.log(`[enrich-images] ${artist.name}: no usable links, skipping`);
    return false;
  }

  for (const platform of candidates) {
    const url = linksByPlatform.get(platform)!;
    const imageUrl = await fetchOgImage(url);

    if (imageUrl) {
      console.log(`[enrich-images] ${artist.name}: found image via ${platform}`);
      const { error: updateError } = await adminClient
        .from("artists")
        .update({
          profile_image_url: imageUrl,
          profile_image_source: platform,
          profile_image_fetched_at: new Date().toISOString(),
        })
        .eq("id", artistId);

      if (updateError) {
        console.error(`[enrich-images] Failed to save image for ${artist.name}:`, updateError.message);
        return false;
      }
      return true;
    }

    await sleep(200);
  }

  console.log(`[enrich-images] ${artist.name}: no image found (tried ${candidates.join(", ")})`);
  return false;
}
