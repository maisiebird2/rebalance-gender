// Multi-platform image enrichment — shared logic used by:
//   - scripts/scrape-images.ts  (bulk CLI, a thin driver over
//     scrapeArtistImages() below)
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
// Ownership: this module owns the platforms that have no harvester of
// their own (SCRAPE_ONLY_PLATFORMS) and is the only thing that ever
// supplies their images. soundcloud and bandcamp belong to
// sync-soundcloud.mjs and sync-bandcamp.mjs, which read a trustworthy
// source (a proper avatar API field, or a page-shape-aware scrape with a
// T-shirt/cover-art guard) rather than a generic og:image scrape that a
// redirect to a track/release page can fool.
//
// For those two, scraping is a fallback with one trigger: the owner ran
// and recorded a *transient* failure, so the answer is unknown rather
// than absent. If it hasn't run yet, succeeded, or recorded a definitive
// result, this module stays out of the way — it never races the owner
// for a row, and never overwrites its pick.
//
// Directory-only, unconditionally: this only ever stores images for
// artists.directory_status = 'approved'. There are roughly 100x as
// many non-directory artists (follow-graph nodes, cold-start search
// results, etc.) as directory ones, and storing images for them would
// balloon Storage/DB use for no benefit. The check happens inside
// scrapeArtistImages() itself, not just at each call site, so no flag
// or future caller can accidentally bypass it.
//
// No cache file: state lives entirely in the DB (per project
// convention) — artist_images itself is the "already got this
// platform's image" record, and every failure goes to harvest_failures
// under the shared key service = "image:<platform>", the same one
// sync-soundcloud.mjs writes. One row per artist/platform describing the
// current state, whichever source produced it, cleared as soon as any
// source succeeds.
//
// The status on that row decides what happens next: a *definitive* one
// (no_image, no_image_tag, placeholder, unreachable) means the answer is
// known, so the platform is skipped until forced or the link changes; a
// *transient* one (fetch_failed, write_failed) means unknown, so it's
// always retried — and is the single condition under which a
// dedicated-harvester platform becomes eligible for a fallback scrape.
// See src/lib/images/failures.ts for the vocabulary.
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
// harvest_failures rows are read/written directly here (a small inline
// upsert/delete) rather than through scripts/lib/harvest-failures.mjs,
// which is written for the scripts/ side and takes a client this module
// doesn't construct. What must not diverge is the *vocabulary* — the
// service key and status set — and that is shared, not copied:
// src/lib/images/failures.ts and placeholders.ts are imported by both
// the scripts/ side (which runs under tsx) and this Next-bundled module.
// Prefer that over the older per-script copies (PLATFORM_PRIORITY in
// store-images.mjs, the domain tables shared by sync-soundcloud and
// sync-bandcamp) when the thing being shared is a fact both sides must
// agree on.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  IMAGE_FAILURE_SERVICE_PREFIX,
  IMAGE_FAILURE_STATUS,
  imageFailureService,
  isDefinitiveImageFailure,
  isTransientImageFailure,
  platformFromImageFailureService,
} from "@/lib/images/failures";
import type { ImageFailureStatus } from "@/lib/images/failures";
import {
  describePlaceholderImageUrl,
  isPlaceholderImageUrl,
} from "@/lib/images/placeholders";

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

// Platforms whose images belong to a dedicated harvester:
//   soundcloud -> sync-soundcloud.mjs (the SoundCloud /resolve API)
//   bandcamp   -> sync-bandcamp.mjs   (the artist page sidebar)
//
// Scraping is a fallback for these, never the primary route, and it
// applies in exactly one situation: the owner ran and recorded a
// *transient* failure. If the owner has not run yet, succeeded, or
// recorded a definitive "no image exists", scraping is not this script's
// job — the owner will get to it. See scripts/IMAGE-HARVESTING-PLAN.md.
export const OWNED_BY_DEDICATED_HARVESTER: ReadonlySet<string> = new Set([
  "soundcloud",
  "bandcamp",
]);

// Platforms with no dedicated harvester, so scrapeArtistImages() is the
// only thing that ever supplies their images.
//
// The web app's after() hooks are scoped to these. soundcloud/bandcamp
// images belong to sync-soundcloud/sync-bandcamp and are left to the
// orchestrator: scraping them from a form handler would race that
// pipeline, because a just-approved artist has no images yet, so the
// scrape always wins the row and is then overwritten by the dedicated
// harvester's result on the next run. Those harvesters already re-detect
// such artists from DB state, so nothing needs to trigger them here.
// See scripts/IMAGE-HARVESTING-PLAN.md (Phase 3).
export const SCRAPE_ONLY_PLATFORMS: readonly string[] = PLATFORM_PRIORITY.filter(
  (p) => !OWNED_BY_DEDICATED_HARVESTER.has(p)
);

// Some platforms serve a generic placeholder in place of a 404 when an
// artist has no real photo — an og:image scrape happily returns it, so
// we reject these as if there were no image tag at all (a stable
// no-image result, recorded in harvest_failures and skipped on retry).
// Match on the stable filename/hash so every size variant of the same
// placeholder is caught.
// Re-exported so existing importers of this module keep their import
// path; the patterns themselves live in the shared registry.
export { isPlaceholderImageUrl };

export type OgImageResult =
  | { found: true; imageUrl: string }
  // transient: true  -> network error, timeout, or 5xx; presumed
  //                     possibly-temporary, always retried.
  // transient: false -> fetched fine but no usable meta tag, or a
  //                     definitive 4xx; stable, eligible to be
  //                     recorded as a skip-on-retry failure.
  //
  // `transient` is derived from `status` rather than tracked separately —
  // the shared vocabulary is the single place that decides which outcomes
  // are worth retrying. See src/lib/images/failures.ts.
  | { found: false; status: ImageFailureStatus; detail: string };

/** Whether a failed OgImageResult should be retried on the next run. */
export function isTransientResult(result: OgImageResult): boolean {
  return !result.found && isTransientImageFailure(result.status);
}

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
      return {
        found: false,
        status:
          res.status >= 500
            ? IMAGE_FAILURE_STATUS.FETCH_FAILED
            : IMAGE_FAILURE_STATUS.UNREACHABLE,
        detail: `HTTP ${res.status}`,
      };
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
      return EMPTY_IMAGE_META_RE.test(html)
        ? {
            found: false,
            status: IMAGE_FAILURE_STATUS.NO_IMAGE,
            detail: "og:image tag present but empty (no photo set)",
          }
        : {
            found: false,
            status: IMAGE_FAILURE_STATUS.NO_IMAGE_TAG,
            detail: "no og:image/twitter:image meta tag",
          };
    }

    const resolved = new URL(imageUrl, url).toString();
    const placeholder = describePlaceholderImageUrl(resolved);
    if (placeholder) {
      // A real page that returned a known "no real photo" placeholder —
      // stable, so record it as a no-image result rather than storing it.
      // Naming the specific placeholder makes a run where a platform
      // starts serving one legible in the logs.
      return {
        found: false,
        status: IMAGE_FAILURE_STATUS.PLACEHOLDER,
        detail: `placeholder image (${placeholder})`,
      };
    }

    return { found: true, imageUrl: resolved };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { found: false, status: IMAGE_FAILURE_STATUS.FETCH_FAILED, detail };
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScrapeArtistImagesOptions {
  // Re-check platforms that already have an artist_images row (or a
  // stable no-image failure), EXCEPT soundcloud/bandcamp — those are
  // never retried here regardless of force.
  force?: boolean;
  // Log what would happen; skip artist_images/harvest_failures writes.
  dryRun?: boolean;
  // Restrict candidates to this subset of PLATFORM_PRIORITY.
  allowedPlatforms?: readonly string[];
}

export interface ScrapeArtistImagesResult {
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
export async function scrapeArtistImages(
  artistId: string,
  adminClient: SupabaseClient,
  { force = false, dryRun = false, allowedPlatforms }: ScrapeArtistImagesOptions = {}
): Promise<ScrapeArtistImagesResult> {
  const result: ScrapeArtistImagesResult = {
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
    console.error(`[scrape-images] Failed to fetch artist ${artistId}:`, error?.message);
    return result;
  }

  // Directory-only, unconditionally — see module header. Checked here
  // regardless of what the caller already believes about this artist.
  if (artist.directory_status !== "approved") {
    console.log(
      `[scrape-images] ${artist.name}: not a directory artist (${artist.directory_status}) — images are only harvested for approved artists, skipping`
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
    console.log(`[scrape-images] ${artist.name}: no usable links, skipping`);
    return result;
  }

  const [{ data: existingImages, error: imagesError }, { data: priorFailures, error: failuresError }] =
    await Promise.all([
      adminClient.from("artist_images").select("platform, source_page_url").eq("artist_id", artistId),
      // Every image-acquisition failure for this artist, from any source
      // (the scrape here, the SoundCloud API path in sync-soundcloud).
      // Statuses are classified below rather than filtered in SQL: a
      // definitive result means "don't re-fetch", a transient one is what
      // makes a dedicated-harvester platform eligible for a fallback.
      adminClient
        .from("harvest_failures")
        .select("service, status, url")
        .eq("artist_id", artistId)
        .like("service", `${IMAGE_FAILURE_SERVICE_PREFIX}%`),
    ]);

  if (imagesError) {
    console.error(`[scrape-images] Failed to load existing images for ${artist.name}:`, imagesError.message);
    return result;
  }
  if (failuresError) {
    // Non-fatal — worst case we re-attempt a platform already known to have no image.
    console.error(`[scrape-images] Failed to load prior failures for ${artist.name}:`, failuresError.message);
  }

  // platform -> the profile URL we last processed for it. For a stored
  // image that's source_page_url (the link we fetched the image from);
  // for a stable no-image failure it's harvest_failures.url. A null
  // value means we have a record but predate URL tracking (a legacy row).
  const imagedUrlByPlatform = new Map<string, string | null>(
    (existingImages ?? []).map((r) => [r.platform as string, (r.source_page_url as string | null) ?? null])
  );
  // platform -> the recorded image failure, whichever source wrote it.
  // Split by classification: a definitive failure means the answer is
  // known and the platform is skipped, while a transient one is the only
  // thing that lets a dedicated-harvester platform fall back to a scrape.
  const definitiveFailureUrlByPlatform = new Map<string, string | null>();
  const transientFailurePlatforms = new Set<string>();
  for (const row of priorFailures ?? []) {
    const platform = platformFromImageFailureService(row.service as string);
    if (!platform) continue;
    const status = row.status as string;
    if (isDefinitiveImageFailure(status)) {
      definitiveFailureUrlByPlatform.set(platform, (row.url as string | null) ?? null);
    } else if (isTransientImageFailure(status)) {
      transientFailurePlatforms.add(platform);
    }
  }

  for (const platform of candidates) {
    const url = linksByPlatform.get(platform)!;
    const service = imageFailureService(platform);
    const hadImage = imagedUrlByPlatform.has(platform);
    const hadFailure = !hadImage && definitiveFailureUrlByPlatform.has(platform);

    // The link we last processed this platform against: source_page_url
    // for a stored image, harvest_failures.url for a confirmed no-image
    // result. A null value is a legacy row from before URL tracking —
    // treat it as still covering the current link (so legacy rows keep
    // their old skip-unless-forced behaviour); undefined = no record.
    const processedUrl = hadImage
      ? imagedUrlByPlatform.get(platform)!
      : hadFailure
        ? definitiveFailureUrlByPlatform.get(platform)!
        : undefined;
    const urlChanged = processedUrl != null && processedUrl !== url;

    // Already answered for this link — an image, or a definitive "no
    // image exists" from any source. Re-fetch only when forced or when
    // the link itself changed.
    if ((hadImage || hadFailure) && !force && !urlChanged) {
      result.skippedExisting.push(platform);
      continue;
    }

    // Platforms with a dedicated harvester belong to it. Scraping is a
    // fallback for exactly one situation: the owner ran and failed in a
    // way that might not recur. If it has not run yet, or it succeeded,
    // or it recorded a definitive answer, this is not our platform to
    // fetch — see scripts/IMAGE-HARVESTING-PLAN.md.
    if (OWNED_BY_DEDICATED_HARVESTER.has(platform) && !transientFailurePlatforms.has(platform)) {
      result.skippedProtected.push(platform);
      continue;
    }

    result.attempted.push(platform);
    const fetched = await fetchOgImage(url);

    if (fetched.found) {
      console.log(`[scrape-images] ${artist.name}: found image via ${platform}`);
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
            `[scrape-images] ${artist.name}: failed to save ${platform} image:`,
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
      const transient = isTransientImageFailure(fetched.status);
      console.log(
        transient
          ? `[scrape-images] ${artist.name}: ${platform} — fetch failed, will retry next run (${fetched.status}: ${fetched.detail})`
          : `[scrape-images] ${artist.name}: ${platform} — no image found (${fetched.status}: ${fetched.detail})`
      );

      // Only a definitive answer retires a stale image: the link changed
      // to a page that genuinely has no image, so the one stored from the
      // previous link must go (see the "link changes" note in the module
      // header). A transient blip proves nothing and leaves it alone, as
      // does a --force re-check of an unchanged link.
      if (!transient && hadImage && urlChanged) {
        console.log(
          `[scrape-images] ${artist.name}: removing stale ${platform} image (link changed to a page with no image)`
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

      // Both classifications are recorded now, not just definitive ones.
      // The row is what a later run reads to decide whether to skip (a
      // definitive status) or to let a dedicated-harvester platform fall
      // back to a scrape (a transient one), and it is deleted as soon as
      // any source succeeds — so this stays one row per artist/platform
      // describing the current state, never a growing log.
      if (!dryRun) {
        await adminClient.from("harvest_failures").upsert(
          {
            artist_id: artistId,
            service,
            status: fetched.status,
            detail: fetched.detail,
            url,
            occurred_at: new Date().toISOString(),
          },
          { onConflict: "artist_id,service" }
        );
      }
    }

    await sleep(200);
  }

  return result;
}
