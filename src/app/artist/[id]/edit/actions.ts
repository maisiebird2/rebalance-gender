"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { cleanLinkUrl } from "@/lib/platforms";
import { resolveProfileLinkUrl } from "@/lib/profile-links";
import { sanitizeAndLinkifyBio } from "@/lib/sanitize-bio";
import { enrichArtistImage, PLATFORM_PRIORITY } from "@/lib/enrich-images";
import type { LinkPlatform, ArtistStatus } from "@/lib/types";

interface LinkInput {
  platform: LinkPlatform;
  url: string | null;
  not_found?: boolean;
}

// ── Handle derivation ─────────────────────────────────────────────
// Derives a handle from a profile URL following the same conventions
// used in the migration scripts (add-beatport-links.mjs, enrich-bios.mjs).

function lastPathSegment(url: string): string | null {
  try {
    const parts = new URL(url).pathname
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
}

function deriveHandle(platform: LinkPlatform, url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);

    switch (platform) {
      case "soundcloud":
      case "instagram":
      case "discogs":
        // https://soundcloud.com/handle
        // https://www.instagram.com/handle/
        // https://www.discogs.com/artist/Handle  (last segment)
        return lastPathSegment(url);

      case "resident_advisor": {
        // https://ra.co/djs/handle
        const match = parsed.pathname.match(/\/djs\/([^/]+)/);
        return match ? match[1] : lastPathSegment(url);
      }

      case "bandcamp": {
        // https://handle.bandcamp.com
        const host = parsed.hostname.toLowerCase();
        const sub = host.replace(/\.bandcamp\.com$/, "");
        return sub !== host ? sub : null;
      }

      case "beatport": {
        // https://www.beatport.com/artist/slug/12345
        // handle = slug between "artist/" and the final numeric segment
        const afterArtist = url.split("artist/")[1];
        if (!afterArtist) return null;
        const withoutQuery = afterArtist.split(/[?#]/)[0];
        const trimmed = withoutQuery.replace(/\/+$/, "");
        const lastSlash = trimmed.lastIndexOf("/");
        return lastSlash === -1 ? trimmed : trimmed.slice(0, lastSlash) || null;
      }

      case "qobuz":
        // https://www.qobuz.com/us-en/interpreter/artist-slug/id
        // second-to-last segment is the slug
        try {
          const parts = new URL(url).pathname
            .split("/")
            .filter(Boolean);
          return parts.length >= 2 ? (parts.at(-2) ?? null) : null;
        } catch {
          return null;
        }

      case "other":
      default:
        return null;
    }
  } catch {
    return null;
  }
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
  const labels = ((formData.get("labels") ?? "") as string).trim() || null;
  const directoryStatus = formData.get("directory_status") as ArtistStatus;
  const locationsRaw = (formData.get("locations") ?? "[]") as string;
  const labelListRaw = (formData.get("label_list") ?? "[]") as string;
  const aliasesRaw = (formData.get("aliases") ?? "[]") as string;
  const genresRaw = (formData.get("genres") ?? "[]") as string;
  const linksRaw = (formData.get("links") ?? "[]") as string;

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
          const url = resolveProfileLinkUrl(l.platform, original_url, cleanLinkUrl);
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
      !existingImageUrls.has(resolveProfileLinkUrl(l.platform, l.url!.trim(), cleanLinkUrl))
  );

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
  // enrichArtistImage skips artists that already have a profile_image_url,
  // so this is a no-op if the artist already has an image.
  if (directoryStatus === "approved" && hasNewImageUrls) {
    after(() => enrichArtistImage(artistId, admin));
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
