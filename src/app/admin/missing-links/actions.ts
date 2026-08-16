"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { deriveHandle, resolveProfileLinkUrl } from "@/lib/profile-links";
import { scheduleLinkResolution } from "@/lib/schedule-link-resolution";
import { scrapeArtistImages, SCRAPE_ONLY_PLATFORMS } from "@/lib/scrape-images";

export interface ActionResult {
  error?: string;
}

// These actions back the admin-only "Missing links" page, so they require
// an admin, not just any signed-in user.
async function requireUser(): Promise<boolean> {
  const { isAdmin } = await getViewer();
  return isAdmin;
}

/**
 * Saves a single platform link for an artist, from the "Missing links"
 * admin page. Applies the same normalization as the edit form
 * (resolveProfileLinkUrl → deriveHandle), replaces any
 * existing row for (artist, platform) so it's safe to retry, and kicks
 * off image enrichment when the platform can provide a profile image.
 *
 * A shortener or share link is followed to its real destination after the
 * response, not before it — see scheduleLinkResolution.
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
  const url = resolveProfileLinkUrl(platform, original_url);

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

  scheduleLinkResolution(admin, artistId);

  // New image-capable link → try to backfill a profile image from just
  // this platform (not a no-op re-check of every platform — this is
  // specifically about the one link that just changed), without
  // blocking the response. soundcloud/bandcamp are excluded: their own
  // harvesters own those images and run from the orchestrator.
  if (SCRAPE_ONLY_PLATFORMS.includes(platform)) {
    after(async () => {
      try {
        await scrapeArtistImages(artistId, admin, { allowedPlatforms: [platform] });
      } catch (e) {
        console.error(`scrapeArtistImages(${artistId}) failed:`, e);
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
