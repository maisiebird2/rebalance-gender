// Multi-platform image enrichment — shared logic used by:
//   - scripts/enrich-images.ts  (bulk CLI, a thin driver over
//     enrichArtistImages() below)
//   - src/app/admin/actions.ts  (quickApprove)
//   - src/app/artist/[id]/edit/actions.ts  (saveArtist, when new
//     image-capable links are added)
//   - src/app/admin/missing-links/actions.ts  (saveArtistPlatformLink)
//
// Given an artist ID, looks at every linked profile the artist has (in
// PLATFORM_PRIORITY order, just to keep run order predictable — every
// candidate is tried, not just the first), fetches each page, and
// pulls the og:image meta tag as a profile photo. Writes one row per
// successful platform to artist_images (artist_id, platform), rather
// than a single artists.profile_image_url winner — an artist can have
// separate stored images from several platforms at once; see
// supabase_migration_artist_images.sql for why.
//
// Two platforms are deliberately off-limits here: soundcloud and
// bandcamp have their own dedicated, better-guarded harvesters
// (sync-soundcloud.mjs, sync-bandcamp.mjs) that pull images from a
// trustworthy source (a proper avatar API field, or a page-shape-aware
// scrape with a T-shirt/cover-art guard) rather than a generic
// og:image scrape, which is more easily fooled by a redirect to a
// track/release page. This module must never clobber their pick, even
// with --force.
//
// Directory-only, unconditionally: this only ever stores images for
// artists.directory_status = 'approved'. There are roughly 100x as
// many non-directory artists (follow-graph nodes, cold-start search
// results, etc.) as directory ones, and storing images for them would
// balloon Storage/DB use for no benefit. The check happens inside
// enrichArtistImages() itself, not just at each call site, so no flag
// or future caller can accidentally bypass it.
//
// No cache file: state lives entirely in the DB (per project
// convention) — artist_images itself is the "already got this
// platform's image" record, and a *confirmed* no-image result (page
// fetched fine, no og:image/twitter:image tag) is recorded in
// harvest_failures as service = "image-enrich:<platform>", status
// 'no_og_image', so it isn't re-fetched every run. A *transient*
// failure (timeout, 5xx, network error) is deliberately NOT part of
// that skip set — those are retried on every call automatically, same
// convention sync-soundcloud.mjs uses for harvest_failures.
//
// harvest_failures rows are read/written directly here (a small
// inline upsert/delete, not an import of
// scripts/lib/harvest-failures.mjs) — this file is bundled into the
// Next.js app as well as run under tsx by the CLI, and
// scripts/lib/harvest-failures.mjs is a plain-Node .mjs written for
// the scripts/ side only. Same per-script-copy convention already
// used for the small domain-classification tables duplicated between
// sync-soundcloud.mjs and sync-bandcamp.mjs, and for
// store-images.mjs's local copy of PLATFORM_PRIORITY.

import type { SupabaseClient } from "@supabase/supabase-js";

// Platform priority: try these link types in this order. Every
// candidate the artist has a link for gets tried (not just the
// first) — this only controls run order, e.g. for log readability.
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

// Platforms with their own dedicated image harvester. Never fetched
// or overwritten by enrichArtistImages(), even with --force.
export const DEDICATED_HARVEST_PLATFORMS: ReadonlySet<string> = new Set([
  "soundcloud",
  "bandcamp",
]);

export type OgImageResult =
  | { found: true; imageUrl: string }
  // transient: true  -> network error, timeout, or 5xx; presumed
  //                     possibly-temporary, always retried.
  // transient: false -> fetched fine but no usable meta tag, or a
  //                     definitive 4xx; stable, eligible to be
  //                     recorded as a skip-on-retry failure.
  | { found: false; transient: boolean; detail: string };

export async function fetchOgImage(url: string): Promise<OgImageResult> {
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

    if (!res.ok) {
      // 5xx is more likely a temporary upstream problem than a 4xx
      // (dead/moved page, which won't fix itself on retry).
      return { found: false, transient: res.status >= 500, detail: `HTTP ${res.status}` };
    }

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
    if (!imageUrl) {
      return { found: false, transient: false, detail: "no og:image/twitter:image meta tag" };
    }

    return { found: true, imageUrl: new URL(imageUrl, url).toString() };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { found: false, transient: true, detail };
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EnrichArtistImagesOptions {
  // Re-check platforms that already have an artist_images row (or a
  // stable no-image failure), EXCEPT soundcloud/bandcamp — those are
  // never retried here regardless of force.
  force?: boolean;
  // Log what would happen; skip artist_images/harvest_failures writes.
  dryRun?: boolean;
  // Restrict candidates to this subset of PLATFORM_PRIORITY.
  allowedPlatforms?: readonly string[];
}

export interface EnrichArtistImagesResult {
  attempted: string[];
  stored: string[];
  skippedExisting: string[]; // already had an image or a stable failure, not forced
  skippedProtected: string[]; // soundcloud/bandcamp — owned by their own harvester
  failed: string[];
}

/**
 * Try every platform link an artist has and upsert an artist_images
 * row for each one that yields a usable og:image and isn't already
 * covered. See the module header for the skip-set and directory-only
 * rules this enforces.
 *
 * Returns a per-platform breakdown rather than a boolean — a single
 * call can both find new images and skip/fail others.
 */
export async function enrichArtistImages(
  artistId: string,
  adminClient: SupabaseClient,
  { force = false, dryRun = false, allowedPlatforms }: EnrichArtistImagesOptions = {}
): Promise<EnrichArtistImagesResult> {
  const result: EnrichArtistImagesResult = {
    attempted: [],
    stored: [],
    skippedExisting: [],
    skippedProtected: [],
    failed: [],
  };

  const { data: artist, error } = await adminClient
    .from("artists")
    .select("id, name, directory_status, links:artist_links(platform, url)")
    .eq("id", artistId)
    .single();

  if (error || !artist) {
    console.error(`[enrich-images] Failed to fetch artist ${artistId}:`, error?.message);
    return result;
  }

  // Directory-only, unconditionally — see module header. Checked here
  // regardless of what the caller already believes about this artist.
  if (artist.directory_status !== "approved") {
    console.log(
      `[enrich-images] ${artist.name}: not a directory artist (${artist.directory_status}) — images are only harvested for approved artists, skipping`
    );
    return result;
  }

  const linksByPlatform = new Map(
    ((artist.links ?? []) as { platform: string; url: string }[]).map((l) => [l.platform, l.url])
  );

  let candidates = PLATFORM_PRIORITY.filter((p) => linksByPlatform.has(p));
  if (allowedPlatforms) {
    const allowed = new Set(allowedPlatforms);
    candidates = candidates.filter((p) => allowed.has(p));
  }
  if (candidates.length === 0) {
    console.log(`[enrich-images] ${artist.name}: no usable links, skipping`);
    return result;
  }

  const [{ data: existingImages, error: imagesError }, { data: stableFailures, error: failuresError }] =
    await Promise.all([
      adminClient.from("artist_images").select("platform").eq("artist_id", artistId),
      adminClient
        .from("harvest_failures")
        .select("service")
        .eq("artist_id", artistId)
        .eq("status", "no_og_image")
        .like("service", "image-enrich:%"),
    ]);

  if (imagesError) {
    console.error(`[enrich-images] Failed to load existing images for ${artist.name}:`, imagesError.message);
    return result;
  }
  if (failuresError) {
    // Non-fatal — worst case we re-attempt a platform already known to have no image.
    console.error(`[enrich-images] Failed to load prior failures for ${artist.name}:`, failuresError.message);
  }

  const existingPlatforms = new Set((existingImages ?? []).map((r) => r.platform as string));
  const stableFailurePlatforms = new Set(
    (stableFailures ?? []).map((r) => (r.service as string).slice("image-enrich:".length))
  );

  for (const platform of candidates) {
    const url = linksByPlatform.get(platform)!;
    const isDedicated = DEDICATED_HARVEST_PLATFORMS.has(platform);
    const service = `image-enrich:${platform}`;

    if (existingPlatforms.has(platform)) {
      if (isDedicated || !force) {
        (isDedicated ? result.skippedProtected : result.skippedExisting).push(platform);
        continue;
      }
    } else if (stableFailurePlatforms.has(platform) && !force) {
      result.skippedExisting.push(platform);
      continue;
    }

    result.attempted.push(platform);
    const fetched = await fetchOgImage(url);

    if (fetched.found) {
      console.log(`[enrich-images] ${artist.name}: found image via ${platform}`);
      if (!dryRun) {
        const { error: upsertError } = await adminClient.from("artist_images").upsert(
          {
            artist_id: artistId,
            platform,
            source_url: fetched.imageUrl,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "artist_id,platform" }
        );
        if (upsertError) {
          console.error(
            `[enrich-images] ${artist.name}: failed to save ${platform} image:`,
            upsertError.message
          );
          result.failed.push(platform);
          await sleep(200);
          continue;
        }
        await adminClient.from("harvest_failures").delete().eq("artist_id", artistId).eq("service", service);
      }
      result.stored.push(platform);
    } else {
      result.failed.push(platform);
      if (!fetched.transient) {
        console.log(`[enrich-images] ${artist.name}: ${platform} — no image found (${fetched.detail})`);
        if (!dryRun) {
          await adminClient.from("harvest_failures").upsert(
            {
              artist_id: artistId,
              service,
              status: "no_og_image",
              detail: fetched.detail,
              url,
              occurred_at: new Date().toISOString(),
            },
            { onConflict: "artist_id,service" }
          );
        }
      } else {
        console.log(
          `[enrich-images] ${artist.name}: ${platform} — fetch failed, will retry next run (${fetched.detail})`
        );
      }
    }

    await sleep(200);
  }

  return result;
}
