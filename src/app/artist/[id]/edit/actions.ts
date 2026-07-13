"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { cleanLinkUrl } from "@/lib/platforms";
import { deriveHandle, resolveProfileLinkUrlAsync } from "@/lib/profile-links";
import { sanitizeAndLinkifyBio } from "@/lib/sanitize-bio";
import { enrichArtistImages, PLATFORM_PRIORITY } from "@/lib/enrich-images";
import type { LinkPlatform, ArtistStatus } from "@/lib/types";

interface LinkInput {
  platform: LinkPlatform;
  url: string | null;
  not_found?: boolean;
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

  // ── 4. Update core artist row ──────────────────────────────────
  const { error: artistErr } = await admin
    .from("artists")
    .update({
      name,
      pronoun_id: pronounId,
      directory_status: directoryStatus,
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
  // detect whether any new ones are being added (to decide if enrichment is needed).
  const imagePlatforms = new Set<string>(PLATFORM_PRIORITY);
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
        await resolveProfileLinkUrlAsync(l.platform, l.url.trim(), cleanLinkUrl)
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
    //    re-added link can be retried cleanly. Services are named
    //    image-<harvester>:<platform> (see enrich-images.ts,
    //    store-images.mjs, prune-artist-images.mjs).
    const removedServices = removedPlatforms.flatMap((p) => [
      `image-enrich:${p}`,
      `image-sync:${p}`,
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
  // enrichArtistImages only attempts platforms that don't already have
  // a stored image (or a confirmed no-image result), so this is a
  // no-op for platforms already covered — cheap to call unconditionally
  // whenever new links might have changed the picture.
  if (directoryStatus === "approved" && hasNewImageUrls) {
    after(() => enrichArtistImages(artistId, admin));
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
