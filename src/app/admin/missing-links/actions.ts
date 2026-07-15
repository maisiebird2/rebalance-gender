"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { deriveHandle, resolveProfileLinkUrlAsync } from "@/lib/profile-links";
import { enrichArtistImages, PLATFORM_PRIORITY } from "@/lib/enrich-images";

export interface ActionResult {
  error?: string;
}

async function requireUser(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user);
}

/**
 * Saves a single platform link for an artist, from the "Missing links"
 * admin page. Applies the same normalization as the edit form
 * (resolveProfileLinkUrlAsync → deriveHandle), replaces any
 * existing row for (artist, platform) so it's safe to retry, and kicks
 * off image enrichment when the platform can provide a profile image.
 */
export async function saveArtistPlatformLink(
  artistId: string,
  platform: string,
  rawUrl: string
): Promise<ActionResult> {
  if (!(await requireUser())) return { error: "Not authenticated" };
  if (!artistId || !platform || !rawUrl.trim()) {
    return { error: "Missing fields" };
  }

  const admin = getSupabaseAdminClient();

  const original_url = rawUrl.trim();
  const url = await resolveProfileLinkUrlAsync(platform, original_url);

  // Replace-then-insert keeps this idempotent (double-click, stale tab).
  await admin
    .from("artist_links")
    .delete()
    .eq("artist_id", artistId)
    .eq("platform", platform);

  const { error } = await admin.from("artist_links").insert({
    artist_id: artistId,
    platform,
    handle: deriveHandle(platform, url),
    url,
    original_url,
    not_found: false,
  });
  if (error) return { error: `Link save error: ${error.message}` };

  // New image-capable link → try to backfill a profile image from just
  // this platform (not a no-op re-check of every platform — this is
  // specifically about the one link that just changed), without
  // blocking the response.
  if ((PLATFORM_PRIORITY as readonly string[]).includes(platform)) {
    after(async () => {
      try {
        await enrichArtistImages(artistId, admin, { allowedPlatforms: [platform] });
      } catch (e) {
        console.error(`enrichArtistImages(${artistId}) failed:`, e);
      }
    });
  }

  revalidatePath("/admin/missing-links");
  revalidatePath(`/artist/${artistId}`);
  return {};
}

/**
 * Records that an artist is NOT on the given platform (not_found row),
 * so they stop appearing in the missing-links list for it.
 */
export async function markArtistLinkNotFound(
  artistId: string,
  platform: string
): Promise<ActionResult> {
  if (!(await requireUser())) return { error: "Not authenticated" };
  if (!artistId || !platform) return { error: "Missing fields" };

  const admin = getSupabaseAdminClient();

  await admin
    .from("artist_links")
    .delete()
    .eq("artist_id", artistId)
    .eq("platform", platform);

  const { error } = await admin.from("artist_links").insert({
    artist_id: artistId,
    platform,
    handle: null,
    url: null,
    not_found: true,
  });
  if (error) return { error: `Save error: ${error.message}` };

  revalidatePath("/admin/missing-links");
  return {};
}
