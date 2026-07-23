"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { deriveHandle, resolveProfileLinkUrlAsync } from "@/lib/profile-links";
import { sanitizeAndLinkifyBio } from "@/lib/sanitize-bio";
import { scrapeArtistImages, SCRAPE_ONLY_PLATFORMS } from "@/lib/scrape-images";
import {
  imageFailureService,
  LEGACY_IMAGE_FAILURE_SERVICE_PREFIXES,
} from "@/lib/images/failures";
import { parseArtistIdInput } from "@/lib/duplicate-of";
import type { DuplicateTargetResult } from "@/lib/duplicate-of";
import type { LinkPlatform, ArtistStatus } from "@/lib/types";

interface LinkInput {
  platform: LinkPlatform;
  url: string | null;
  not_found?: boolean;
}

/**
 * Check an entered "Duplicate of" value: that it contains an artist id at all,
 * and that the id names an artist this row may legitimately point at.
 *
 * Rejects a soft-deleted target, the artist itself, and a target that is
 * itself a duplicate — the last so duplicates always point straight at a
 * canonical entry instead of forming chains that every reader would have to
 * walk. Shared by the on-blur check and saveArtist, so the two can't drift.
 */
async function resolveDuplicateTarget(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  raw: string,
  selfId: string
): Promise<DuplicateTargetResult> {
  const targetId = parseArtistIdInput(raw);
  if (!targetId) {
    return {
      ok: false,
      error: "Enter an artist ID or paste an artist page URL.",
    };
  }
  if (targetId === selfId) {
    return { ok: false, error: "An artist can't be a duplicate of itself." };
  }

  const { data, error } = await admin
    .from("artists")
    .select("id, name, deleted, directory_status")
    .eq("id", targetId)
    .maybeSingle();

  if (error) return { ok: false, error: `Lookup failed: ${error.message}` };
  if (!data) return { ok: false, error: "No artist found with that ID." };
  if (data.deleted) {
    return { ok: false, error: `“${data.name}” has been deleted.` };
  }
  if (data.directory_status === "duplicate") {
    return {
      ok: false,
      error: `“${data.name}” is itself marked a duplicate — point at the entry being kept.`,
    };
  }

  return { ok: true, id: data.id as string, name: data.name as string };
}

/**
 * On-blur check for the edit form's "Duplicate of" field. Returns the matched
 * artist's name so the form can show what the pasted ID actually resolved to.
 */
export async function checkDuplicateTarget(
  raw: string,
  selfId: string
): Promise<DuplicateTargetResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  return resolveDuplicateTarget(getSupabaseAdminClient(), raw, selfId);
}

export async function saveArtist(
  formData: FormData
): Promise<{ error: string } | void> {
  // ── 1. Auth check ─────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  // ── 2. Parse form data ────────────────────────────────────────
  const artistId = formData.get("artist_id") as string;
  const name = ((formData.get("name") ?? "") as string).trim();
  const pronounsValue = ((formData.get("pronouns") ?? "") as string).trim();
  const directoryStatus = formData.get("directory_status") as ArtistStatus;
  const duplicateOfRaw = ((formData.get("duplicate_of") ?? "") as string).trim();
  const locationsRaw = (formData.get("locations") ?? "[]") as string;
  const labelListRaw = (formData.get("label_list") ?? "[]") as string;
  const aliasesRaw = (formData.get("aliases") ?? "[]") as string;
  const genresRaw = (formData.get("genres") ?? "[]") as string;
  const linksRaw = (formData.get("links") ?? "[]") as string;

  const notes = ((formData.get("notes") ?? "") as string).trim() || null;
  const bio = ((formData.get("bio") ?? "") as string).trim() || null;
  const bookingInfo = ((formData.get("booking_info") ?? "") as string).trim() || null;
  const managementInfo = ((formData.get("management_info") ?? "") as string).trim() || null;
  const contactInfo = ((formData.get("contact_info") ?? "") as string).trim() || null;

  if (!artistId || !name) return { error: "Missing required fields" };

  let genreNames: string[] = [];
  try {
    genreNames = (JSON.parse(genresRaw || "[]") as string[]).filter(Boolean);
  } catch {
    return { error: "Invalid genres data" };
  }

  let links: LinkInput[] = [];
  try {
    links = JSON.parse(linksRaw || "[]");
  } catch {
    return { error: "Invalid links data" };
  }

  let labelNames: string[] = [];
  try {
    labelNames = (JSON.parse(labelListRaw || "[]") as string[]).filter(Boolean);
  } catch {
    return { error: "Invalid labels data" };
  }

  let aliasNameList: string[] = [];
  try {
    aliasNameList = (JSON.parse(aliasesRaw || "[]") as string[]).filter(Boolean);
  } catch {
    return { error: "Invalid aliases data" };
  }

  interface LocationInput { city?: string; country?: string; }
  let locationInputs: LocationInput[] = [];
  try {
    locationInputs = JSON.parse(locationsRaw || "[]");
  } catch {
    return { error: "Invalid locations data" };
  }

  const admin = getSupabaseAdminClient();

  // ── 3. Upsert pronoun ─────────────────────────────────────────
  let pronounId: number | null = null;
  if (pronounsValue) {
    const { data: existing } = await admin
      .from("pronouns")
      .select("id")
      .eq("value", pronounsValue)
      .maybeSingle();

    if (existing) {
      pronounId = existing.id;
    } else {
      const { data: created, error: pErr } = await admin
        .from("pronouns")
        .insert({ value: pronounsValue })
        .select("id")
        .single();
      if (pErr) return { error: `Pronoun error: ${pErr.message}` };
      pronounId = created.id;
    }
  }

  // ── 3b. Resolve the duplicate target ──────────────────────────
  // Re-checked here rather than trusting the form's on-blur result: the field
  // is free text, and the artist it names can change between blur and save.
  // Any status other than 'duplicate' clears the column, so flipping an entry
  // back to approved never leaves a stale pointer behind. An empty value is
  // allowed — a row can be known to be a duplicate before the entry it
  // duplicates has been found.
  let duplicateOf: string | null = null;
  if (directoryStatus === "duplicate" && duplicateOfRaw) {
    const target = await resolveDuplicateTarget(admin, duplicateOfRaw, artistId);
    if (!target.ok) return { error: `Duplicate of: ${target.error}` };
    duplicateOf = target.id;
  }

  // ── 4. Update core artist row ──────────────────────────────────
  const { error: artistErr } = await admin
    .from("artists")
    .update({
      name,
      pronoun_id: pronounId,
      directory_status: directoryStatus,
      duplicate_of: duplicateOf,
      notes,
      booking_info: bookingInfo,
      management_info: managementInfo,
      contact_info: contactInfo,
    })
    .eq("id", artistId);

  if (artistErr) return { error: `Artist save error: ${artistErr.message}` };

  // ── 5. Replace labels ─────────────────────────────────────────
  await admin.from("artist_labels").delete().eq("artist_id", artistId);

  if (labelNames.length > 0) {
    const { error: labErr } = await admin.from("artist_labels").insert(
      labelNames.map((name) => ({ artist_id: artistId, name }))
    );
    if (labErr) return { error: `Labels save error: ${labErr.message}` };
  }

  // ── 6. Replace aliases ────────────────────────────────────────
  await admin.from("artist_aliases").delete().eq("artist_id", artistId);

  if (aliasNameList.length > 0) {
    const { error: aliasErr } = await admin.from("artist_aliases").insert(
      aliasNameList.map((name) => ({ artist_id: artistId, name }))
    );
    if (aliasErr) return { error: `Aliases save error: ${aliasErr.message}` };
  }

  // ── 7. Replace locations ──────────────────────────────────────
  await admin.from("artist_locations").delete().eq("artist_id", artistId);

  const validLocations = locationInputs.filter((l) => l.city || l.country);
  if (validLocations.length > 0) {
    const { error: locErr } = await admin.from("artist_locations").insert(
      validLocations.map((l) => ({
        artist_id: artistId,
        city: l.city?.trim() || null,
        country: l.country?.trim() || null,
        raw_text: [l.city, l.country].filter(Boolean).join(", "),
      }))
    );
    if (locErr) return { error: `Location error: ${locErr.message}` };
  }

  // ── 7. Replace genres ─────────────────────────────────────────
  await admin.from("artist_genres").delete().eq("artist_id", artistId);

  if (genreNames.length > 0) {
    const genreIds: number[] = [];

    for (const gName of genreNames) {
      const { data: existing } = await admin
        .from("genres")
        .select("id")
        .eq("name", gName)
        .maybeSingle();

      if (existing) {
        genreIds.push(existing.id);
      } else {
        const { data: created, error: gErr } = await admin
          .from("genres")
          .insert({ name: gName })
          .select("id")
          .single();
        if (gErr) return { error: `Genre error: ${gErr.message}` };
        genreIds.push(created.id);
      }
    }

    const { error: agErr } = await admin.from("artist_genres").insert(
      genreIds.map((genre_id) => ({ artist_id: artistId, genre_id }))
    );
    if (agErr) return { error: `Genres save error: ${agErr.message}` };
  }

  // ── 7. Replace links ──────────────────────────────────────────

  // Snapshot current image-capable URLs before we replace links, so we can
  // detect whether any new ones are being added (to decide if enrichment is
  // needed). Scoped to the platforms this route can actually enrich, so a
  // changed soundcloud/bandcamp link doesn't schedule a no-op pass.
  const imagePlatforms = new Set<string>(SCRAPE_ONLY_PLATFORMS);
  const { data: existingImageLinks } = await admin
    .from("artist_links")
    .select("url")
    .eq("artist_id", artistId)
    .in("platform", [...imagePlatforms])
    .not("url", "is", null);
  const existingImageUrls = new Set((existingImageLinks ?? []).map((l) => l.url as string));

  await admin.from("artist_links").delete().eq("artist_id", artistId);

  // Resolve each link's stored URL once (async: SoundCloud mobile share links
  // need a redirect-follow), keyed by the link object so both the insert below
  // and the new-image-URL check reuse the same resolved value — no double fetch.
  const resolvedUrls = new Map<(typeof links)[number], string>();
  for (const l of links) {
    if (!l.not_found && l.url?.trim()) {
      resolvedUrls.set(
        l,
        await resolveProfileLinkUrlAsync(l.platform, l.url.trim())
      );
    }
  }

  if (links.length > 0) {
    const validLinks = links.filter((l) => l.not_found || l.url?.trim());
    if (validLinks.length > 0) {
      const { error: lErr } = await admin.from("artist_links").insert(
        validLinks.map((l) => {
          if (l.not_found) {
            return {
              artist_id: artistId,
              platform: l.platform,
              handle: null,
              url: null,
              not_found: true,
            };
          }
          const original_url = l.url!.trim();
          const url = resolvedUrls.get(l)!;
          return {
            artist_id: artistId,
            platform: l.platform,
            handle: deriveHandle(l.platform, url),
            url,
            original_url,
            not_found: false,
          };
        })
      );
      if (lErr) return { error: `Links save error: ${lErr.message}` };
    }
  }

  // Check whether any new image-capable URLs were introduced.
  const hasNewImageUrls = links.some(
    (l) =>
      !l.not_found &&
      l.url?.trim() &&
      imagePlatforms.has(l.platform) &&
      !existingImageUrls.has(resolvedUrls.get(l)!)
  );

  // ── 7b. Prune images for platforms whose link was removed ─────
  // Removing a platform link (or marking it not-found) should also drop
  // any profile image harvested from that platform — otherwise a stale
  // photo from a now-removed profile keeps showing, since pickArtistImage
  // rotates over whatever artist_images rows exist regardless of links.
  // The form submits an entry for every platform, so a platform absent
  // from the surviving links genuinely means it was cleared. Mirror
  // scripts/prune-artist-images.mjs: remove the re-hosted Storage object,
  // delete the row, then clear that platform's image-harvest failures so
  // a later re-added link isn't treated as pre-failed.
  const survivingLinkPlatforms = new Set(
    links.filter((l) => !l.not_found && l.url?.trim()).map((l) => l.platform)
  );

  const { data: currentImages } = await admin
    .from("artist_images")
    .select("platform, storage_path")
    .eq("artist_id", artistId);

  const imagesToRemove = (currentImages ?? []).filter(
    (img) => !survivingLinkPlatforms.has(img.platform as string)
  );

  if (imagesToRemove.length > 0) {
    const removedPlatforms = imagesToRemove.map((img) => img.platform as string);

    // 1. Re-hosted Storage objects (storage_path is null for rows that
    //    predate re-hosting — nothing to remove for those).
    const storagePaths = imagesToRemove
      .map((img) => img.storage_path as string | null)
      .filter((p): p is string => Boolean(p));
    if (storagePaths.length > 0) {
      const { error: storageErr } = await admin.storage
        .from("artist-images")
        .remove(storagePaths);
      // A Storage hiccup shouldn't abort the save — deleting the row
      // below is what actually hides the image; log the orphaned object
      // for later cleanup (prune-artist-images.mjs).
      if (storageErr) {
        console.error(
          `[saveArtist] Failed to remove Storage objects for ${artistId}:`,
          storageErr.message
        );
      }
    }

    // 2. artist_images rows.
    const { error: imgDelErr } = await admin
      .from("artist_images")
      .delete()
      .eq("artist_id", artistId)
      .in("platform", removedPlatforms);
    if (imgDelErr) return { error: `Image cleanup error: ${imgDelErr.message}` };

    // 3. Lingering image-harvest failures for those platforms, so a
    //    re-added link can be retried cleanly. Acquisition failures share
    //    one key per platform (src/lib/images/failures.ts); the legacy
    //    prefixes cover rows written before that, and image-store: is the
    //    separate re-hosting namespace owned by store-images.mjs.
    const removedServices = removedPlatforms.flatMap((p) => [
      imageFailureService(p),
      ...LEGACY_IMAGE_FAILURE_SERVICE_PREFIXES.map((prefix) => `${prefix}${p}`),
      `image-store:${p}`,
    ]);
    const { error: failErr } = await admin
      .from("harvest_failures")
      .delete()
      .eq("artist_id", artistId)
      .in("service", removedServices);
    if (failErr) {
      console.error(
        `[saveArtist] Failed to clear image harvest_failures for ${artistId}:`,
        failErr.message
      );
    }
  }

  // ── 8. Upsert SoundCloud bio in enrichment ────────────────────
  if (bio !== null) {
    let bio_sanitized: string;
    try {
      bio_sanitized = sanitizeAndLinkifyBio(bio);
    } catch (err) {
      console.error("sanitizeAndLinkifyBio error:", err);
      bio_sanitized = bio; // fall back to raw text if sanitization fails
    }
    const { error: enrichErr } = await admin
      .from("artist_enrichment")
      .upsert(
        { artist_id: artistId, platform: "soundcloud", bio, bio_sanitized },
        { onConflict: "artist_id,platform" }
      );
    if (enrichErr)
      return { error: `Bio save error: ${enrichErr.message}` };
  }

  // ── 9. Trigger image enrichment if warranted ──────────────────
  // Run after the response is sent so it doesn't block the redirect.
  // scrapeArtistImages only attempts platforms that don't already have
  // a stored image (or a confirmed no-image result) for their *current*
  // link — a platform whose image is up to date is a no-op, but one
  // whose link URL just changed is re-fetched (hasNewImageUrls, which
  // gates this, is exactly "a submitted link URL differs from before").
  // Restricted to SCRAPE_ONLY_PLATFORMS: soundcloud/bandcamp belong to
  // their own harvesters, which run from the orchestrator.
  if (directoryStatus === "approved" && hasNewImageUrls) {
    after(() =>
      scrapeArtistImages(artistId, admin, { allowedPlatforms: SCRAPE_ONLY_PLATFORMS })
    );
  }

  // ── 10. Revalidate caches and redirect ─────────────────────────
  revalidatePath(`/artist/${artistId}`);
  revalidatePath("/");
  // The public artist page only renders approved artists. Redirect to the
  // admin panel for any other status so we don't land on a 404.
  if (directoryStatus === "approved") {
    redirect(`/artist/${artistId}`);
  } else {
    redirect(`/admin`);
  }
}

export async function deleteArtist(
  artistId: string
): Promise<{ error: string } | void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ deleted: true })
    .eq("id", artistId);

  if (error) return { error: error.message };

  revalidatePath("/");
  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
