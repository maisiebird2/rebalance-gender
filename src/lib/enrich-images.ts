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
// Known "no real photo" placeholders (e.g. Last.fm's default star
// avatar) are rejected as if the page had no og:image at all — see
// isPlaceholderImageUrl — so a generic silhouette is never stored and
// the artist is recorded as a stable no-image result instead.
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
// The skip set is keyed to the exact link, not just the platform: both
// records store the profile URL they came from (artist_images.source_page_url
// for a stored image, harvest_failures.url for a no-image result), and a
// platform is only skipped when the artist's *current* link for it still
// matches. When a link is edited/corrected to a different URL, that URL
// is treated as never-tried and re-fetched automatically — no --force
// needed. (Rows predating source_page_url have it null; a null recorded
// URL is treated as still covering the current link, so legacy rows keep
// their old skip-unless-forced behaviour.) See
// supabase_migration_artist_images_source_page_url.sql.
//
// If a link changes to a page that has no image, any image previously
// stored for that platform (fetched from the old link) is DELETED, so a
// stored image always reflects the artist's current link rather than a
// now-delinked URL. That delete also drops any re-hosted storage copy's
// row — an accepted trade for keeping artist_images consistent with the
// live links.
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
//
// "other" and "homepage" are deliberately excluded: both are catch-alls
// pointing at arbitrary third-party websites with no consistent page
// shape, so an og:image scrape can't reliably pull a genuine profile
// photo from them (and often grabs an unrelated hero/banner image).
// Neither is a candidate here, so such a link is never fetched or
// recorded as a failure — same treatment as a not-found slot. This
// mirrors qc-links.mjs, which omits the same two platforms from its
// domain cross-check because any domain is valid for them.
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
] as const;

// Platforms with their own dedicated image harvester. Never fetched
// or overwritten by enrichArtistImages(), even with --force.
export const DEDICATED_HARVEST_PLATFORMS: ReadonlySet<string> = new Set([
  "soundcloud",
  "bandcamp",
]);

// Some platforms serve a generic placeholder in place of a 404 when an
// artist has no real photo — an og:image scrape happily returns it, so
// we reject these as if there were no image tag at all (a stable
// no-image result, recorded in harvest_failures and skipped on retry).
// Match on the stable filename/hash so every size variant of the same
// placeholder is caught.
const PLACEHOLDER_IMAGE_PATTERNS: readonly RegExp[] = [
  // Last.fm's default "star" artist avatar, e.g.
  // https://lastfm.freetls.fastly.net/i/u/ar0/2a96cbd8b46e442fc41c2b86b821562f.jpg
  // — the same hash is served at every size variant (ar0/174s/300x300/…),
  // so matching the hash alone catches all of them.
  /2a96cbd8b46e442fc41c2b86b821562f/i,
];

export function isPlaceholderImageUrl(imageUrl: string): boolean {
  return PLACEHOLDER_IMAGE_PATTERNS.some((re) => re.test(imageUrl));
}

export type OgImageResult =
  | { found: true; imageUrl: string }
  // transient: true  -> network error, timeout, or 5xx; presumed
  //                     possibly-temporary, always retried.
  // transient: false -> fetched fine but no usable meta tag, or a
  //                     definitive 4xx; stable, eligible to be
  //                     recorded as a skip-on-retry failure.
  | { found: false; transient: boolean; detail: string };

// Ceiling on how much of a page we'll buffer looking for a meta tag.
// YouTube channel pages reach ~1.15MB with og:image at ~690KB.
const MAX_HTML_BYTES = 1_500_000;
// Longest plausible <meta> tag, used as the rescan window across chunks.
const META_TAG_OVERLAP = 2_000;

// Each matches a <meta> tag for one property in either attribute order
// (property/name first, or content first). Kept separate rather than
// alternated in one regex so og:image can win outright — we only need
// one image per platform, so twitter:image is a fallback, never a race.
const OG_IMAGE_RE =
  /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["'][^>]*>/i;
const TWITTER_IMAGE_RE =
  /<meta[^>]+(?:property|name)=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']twitter:image["'][^>]*>/i;

// Matches an og:image/twitter:image tag whose content is empty (SoundCloud
// emits content="" for artists with no avatar). The backreference keeps the
// quote characters matched, so content="' isn't read as an empty value.
const EMPTY_IMAGE_META_RE =
  /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=(["'])\1[^>]*>|<meta[^>]+content=(["'])\2[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i;

function matchImageUrl(html: string, re: RegExp): string | undefined {
  const match = html.match(re);
  return match?.[1] || match?.[2];
}

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

    // Stream the page and stop the moment og:image turns up. Don't stop
    // at </head>: YouTube emits its social meta tags inside <body>, ~50KB
    // past the closing head tag and ~690KB into a >1MB document, so both
    // a head-only read and a small size cap silently miss them.
    const reader = res.body?.getReader();
    let html = "";
    let ogImageUrl: string | undefined;
    if (reader) {
      const decoder = new TextDecoder();
      // Rescan the tail of the previous chunk so a meta tag straddling a
      // chunk boundary is still matched.
      let scannedTo = 0;
      while (html.length < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        ogImageUrl = matchImageUrl(html.slice(scannedTo), OG_IMAGE_RE);
        if (ogImageUrl) break;
        scannedTo = Math.max(0, html.length - META_TAG_OVERLAP);
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
      ogImageUrl = matchImageUrl(html, OG_IMAGE_RE);
    }

    // One image per platform is enough, so twitter:image is consulted
    // only when the whole page yielded no og:image.
    const imageUrl = ogImageUrl ?? matchImageUrl(html, TWITTER_IMAGE_RE);
    if (!imageUrl) {
      // Both are stable failures, but they mean different things: an empty
      // tag is the platform saying this artist has no photo, while no tag
      // at all can mean the scrape itself broke (page shape changed, bot
      // challenge served). Keep them distinct so the second stands out in
      // logs instead of blending into the expected background of artists
      // who genuinely have no picture.
      const detail = EMPTY_IMAGE_META_RE.test(html)
        ? "og:image tag present but empty (no photo set)"
        : "no og:image/twitter:image meta tag";
      return { found: false, transient: false, detail };
    }

    const resolved = new URL(imageUrl, url).toString();
    if (isPlaceholderImageUrl(resolved)) {
      // A real page that returned a known "no real photo" placeholder —
      // stable, so record it as a no-image result rather than storing it.
      return { found: false, transient: false, detail: "placeholder image (platform default, no real photo)" };
    }

    return { found: true, imageUrl: resolved };
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
  removed: string[]; // stale image dropped: link changed to a page with no image
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
    removed: [],
    skippedExisting: [],
    skippedProtected: [],
    failed: [],
  };

  const { data: artist, error } = await adminClient
    .from("artists")
    .select("id, name, directory_status, links:artist_links(platform, url, not_found)")
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

  // A link marked "not found" (an admin recorded that the artist isn't on
  // this platform — artist_links.not_found = true, url null) is treated
  // exactly like a platform the artist has no row for at all: it's not a
  // candidate, so it's never fetched and never recorded as a failure. It
  // only comes back into play if a real URL is later entered for that slot
  // (which clears not_found). Also drops any row that somehow has no url,
  // which would otherwise fail with "Failed to parse URL from null".
  const linksByPlatform = new Map(
    ((artist.links ?? []) as { platform: string; url: string; not_found?: boolean }[])
      .filter((l) => !l.not_found && l.url)
      .map((l) => [l.platform, l.url])
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
      adminClient.from("artist_images").select("platform, source_page_url").eq("artist_id", artistId),
      adminClient
        .from("harvest_failures")
        .select("service, url")
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

  // platform -> the profile URL we last processed for it. For a stored
  // image that's source_page_url (the link we fetched the image from);
  // for a stable no-image failure it's harvest_failures.url. A null
  // value means we have a record but predate URL tracking (a legacy row).
  const imagedUrlByPlatform = new Map<string, string | null>(
    (existingImages ?? []).map((r) => [r.platform as string, (r.source_page_url as string | null) ?? null])
  );
  const failedUrlByPlatform = new Map<string, string | null>(
    (stableFailures ?? []).map((r) => [
      (r.service as string).slice("image-enrich:".length),
      (r.url as string | null) ?? null,
    ])
  );

  for (const platform of candidates) {
    const url = linksByPlatform.get(platform)!;
    const isDedicated = DEDICATED_HARVEST_PLATFORMS.has(platform);
    const service = `image-enrich:${platform}`;
    const hadImage = imagedUrlByPlatform.has(platform);
    const hadFailure = !hadImage && failedUrlByPlatform.has(platform);

    // The link we last processed this platform against: source_page_url
    // for a stored image, harvest_failures.url for a confirmed no-image
    // result. A null value is a legacy row from before URL tracking —
    // treat it as still covering the current link (so legacy rows keep
    // their old skip-unless-forced behaviour); undefined = no record.
    const processedUrl = hadImage
      ? imagedUrlByPlatform.get(platform)!
      : hadFailure
        ? failedUrlByPlatform.get(platform)!
        : undefined;
    const urlChanged = processedUrl != null && processedUrl !== url;

    // soundcloud/bandcamp are owned by their dedicated harvesters —
    // never re-fetched or overwritten here, even on a link change or
    // with --force.
    if (hadImage && isDedicated) {
      result.skippedProtected.push(platform);
      continue;
    }
    // Skip a platform already covered for its current link, unless forced
    // or the link has changed — a changed link is re-fetched automatically.
    if ((hadImage || hadFailure) && !force && !urlChanged) {
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
            source_page_url: url,
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
        if (hadImage && urlChanged) {
          // The link changed to a page with no image, and a stale image
          // survives from the previous link — drop it so a stored image
          // always reflects the current link (see the "link changes" note
          // in the module header). Only on a genuine link change: a --force
          // re-check of an unchanged link whose page merely lost its image
          // leaves the existing image in place.
          console.log(
            `[enrich-images] ${artist.name}: removing stale ${platform} image (link changed to a page with no image)`
          );
          result.removed.push(platform);
          if (!dryRun) {
            await adminClient
              .from("artist_images")
              .delete()
              .eq("artist_id", artistId)
              .eq("platform", platform);
          }
        }
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
