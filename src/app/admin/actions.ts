"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { enrichArtistImage } from "@/lib/enrich-images";

async function requireAuth() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");
}

// ── Submission moderation ──────────────────────────────────────────

export async function quickApprove(id: string): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "approved" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  // Run image enrichment in the background after the response is sent.
  after(() => enrichArtistImage(id, admin));
}

export async function quickReject(id: string): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "rejected" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
}

export async function quickMarkNotEligible(id: string): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "not_eligible" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath(`/artist/${id}`);
}

// ── Genres ──────────────────────────────────────────────────────────

export async function addGenre(
  formData: FormData
): Promise<{ error: string } | { success: true }> {
  await requireAuth();

  const name = ((formData.get("name") ?? "") as string).trim();
  if (!name) return { error: "Genre name is required" };

  const admin = getSupabaseAdminClient();

  const { data: existing } = await admin
    .from("genres")
    .select("id, status")
    .eq("name", name)
    .maybeSingle();

  if (existing) {
    // If it was previously deleted, un-delete and approve it.
    if (existing.status === "deleted") {
      const { error } = await admin
        .from("genres")
        .update({ status: "approved" })
        .eq("id", existing.id);
      if (error) return { error: error.message };
      revalidatePath("/admin");
      revalidatePath("/submit");
      revalidatePath("/");
      revalidateTag("genres", "max");
      return { success: true };
    }
    return { error: `"${name}" already exists` };
  }

  // Admin is explicitly adding this genre — approve it immediately.
  const { error } = await admin.from("genres").insert({ name, status: "approved" });
  if (error) return { error: error.message };

  revalidatePath("/admin");
  revalidatePath("/submit");
  revalidatePath("/");
  revalidateTag("genres", "max");
  return { success: true };
}

export async function approveGenre(
  id: number
): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("genres")
    .update({ status: "approved" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  revalidateTag("genres", "max");
}

export async function deleteGenre(
  id: number
): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("genres")
    .update({ status: "deleted" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  revalidateTag("genres", "max");
}

export async function restoreGenre(
  id: number
): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("genres")
    .update({ status: "approved" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  revalidateTag("genres", "max");
}

// ── Revision moderation ────────────────────────────────────────────────

export async function approveRevision(
  revisionId: string
): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();

  // Fetch the revision and its proposed changes.
  const { data: revision, error: revError } = await admin
    .from("artist_revisions")
    .select("*")
    .eq("id", revisionId)
    .single();

  if (revError || !revision) return { error: "Revision not found" };

  const rd = revision.revision_data as {
    name?: string;
    pronouns?: string;
    genres?: string[];
    locations?: { city?: string; country?: string }[];
    labels?: string[];
    aliases?: string[];
    links?: Record<string, string>;
  };

  const artistId = revision.artist_id as string;
  const now = new Date().toISOString();

  // Apply artist-level fields (name, pronouns).
  const artistUpdate: Record<string, unknown> = { updated_at: now };
  if (rd.name) artistUpdate.name = rd.name;

  if (rd.pronouns) {
    const pronounValue = rd.pronouns.trim().toLowerCase();
    const { data: existing } = await admin
      .from("pronouns")
      .select("id")
      .eq("value", pronounValue)
      .maybeSingle();
    let pronounId: number;
    if (existing) {
      pronounId = existing.id;
    } else {
      const { data: created } = await admin
        .from("pronouns")
        .insert({ value: pronounValue })
        .select("id")
        .single();
      pronounId = created?.id;
    }
    if (pronounId) artistUpdate.pronoun_id = pronounId;
  }

  if (Object.keys(artistUpdate).length > 1) {
    const { error } = await admin.from("artists").update(artistUpdate).eq("id", artistId);
    if (error) return { error: error.message };
  }

  // Replace genres.
  if (rd.genres?.length) {
    await admin.from("artist_genres").delete().eq("artist_id", artistId);
    for (const genreName of rd.genres.map((g) => g.trim().toLowerCase()).filter(Boolean)) {
      const { data: existing } = await admin.from("genres").select("id").eq("name", genreName).maybeSingle();
      let genreId: number;
      if (existing) {
        genreId = existing.id;
      } else {
        const { data: created } = await admin.from("genres").insert({ name: genreName }).select("id").single();
        if (!created) continue;
        genreId = created.id;
      }
      await admin.from("artist_genres").insert({ artist_id: artistId, genre_id: genreId });
    }
  }

  // Replace locations.
  if (rd.locations?.length) {
    await admin.from("artist_locations").delete().eq("artist_id", artistId);
    const validLocs = rd.locations.filter((l) => l.city?.trim() || l.country?.trim());
    if (validLocs.length) {
      await admin.from("artist_locations").insert(
        validLocs.map((l) => ({
          artist_id: artistId,
          city: l.city?.trim() || null,
          country: l.country?.trim() || null,
          raw_text: [l.city, l.country].filter(Boolean).join(", "),
        }))
      );
    }
  }

  // Replace labels.
  if (rd.labels?.length) {
    await admin.from("artist_labels").delete().eq("artist_id", artistId);
    const validLabels = rd.labels.map((l) => l.trim()).filter(Boolean);
    if (validLabels.length) {
      await admin.from("artist_labels").insert(
        validLabels.map((name) => ({ artist_id: artistId, name }))
      );
    }
  }

  // Replace aliases.
  if (rd.aliases?.length) {
    await admin.from("artist_aliases").delete().eq("artist_id", artistId);
    const validAliases = rd.aliases.map((a) => a.trim()).filter(Boolean);
    if (validAliases.length) {
      await admin.from("artist_aliases").insert(
        validAliases.map((name) => ({ artist_id: artistId, name }))
      );
    }
  }

  // Merge links (upsert — don't delete links not mentioned in revision).
  if (rd.links && Object.keys(rd.links).length) {
    const { cleanLinkUrl } = await import("@/lib/platforms");
    const { resolveProfileLinkUrlAsync } = await import("@/lib/profile-links");
    const rows = await Promise.all(
      Object.entries(rd.links)
        .filter(([, url]) => url?.trim())
        .map(async ([platform, url]) => ({
          artist_id: artistId,
          platform,
          original_url: url.trim(),
          url: await resolveProfileLinkUrlAsync(platform, url.trim(), cleanLinkUrl),
        }))
    );
    if (rows.length) {
      await admin.from("artist_links").upsert(rows, { onConflict: "artist_id,platform" });
    }
  }

  // Mark revision approved.
  const { error: revUpdateError } = await admin
    .from("artist_revisions")
    .update({ status: "approved", reviewed_at: now })
    .eq("id", revisionId);

  if (revUpdateError) return { error: revUpdateError.message };

  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath(`/artist/${artistId}`);
}

export async function rejectRevision(
  revisionId: string
): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artist_revisions")
    .update({ status: "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", revisionId);
  if (error) return { error: error.message };
  revalidatePath("/admin");
}

// ── Submitter email management ─────────────────────────────────────────

export async function blockEmail(
  email: string,
  reason?: string
): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("submitter_emails")
    .upsert({
      email,
      status: "blocked",
      blocked_at: new Date().toISOString(),
      block_reason: reason ?? null,
    }, { onConflict: "email" });
  if (error) return { error: error.message };
  revalidatePath("/admin");
}

export async function unblockEmail(
  email: string
): Promise<{ error: string } | void> {
  await requireAuth();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("submitter_emails")
    .update({ status: "verified", blocked_at: null, block_reason: null })
    .eq("email", email);
  if (error) return { error: error.message };
  revalidatePath("/admin");
}

// ── Profile link categories (platforms) ──────────────────────────────

// Derives a stable lookup key from a display label, e.g.
// "Mixcloud" -> "mixcloud", "NTS Radio" -> "nts_radio".
function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function addPlatform(
  formData: FormData
): Promise<{ error: string } | { success: true }> {
  await requireAuth();

  const label = ((formData.get("label") ?? "") as string).trim();
  if (!label) return { error: "Category name is required" };

  const key = slugify(label);
  if (!key) return { error: "Couldn't derive a key from that name — try adding a letter or number" };

  const admin = getSupabaseAdminClient();

  const { data: existing } = await admin
    .from("platforms")
    .select("key")
    .eq("key", key)
    .maybeSingle();
  if (existing) return { error: `"${label}" already exists` };

  const { data: maxRow } = await admin
    .from("platforms")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (maxRow?.sort_order ?? 0) + 10;

  const { error } = await admin
    .from("platforms")
    .insert({ key, label, sort_order: sortOrder });
  if (error) return { error: error.message };

  revalidatePath("/admin");
  revalidatePath("/submit");
  return { success: true };
}

// ── Site content (editable pages, e.g. /about) ─────────────────────

export async function saveSiteContent(
  key: string,
  value: string,
): Promise<{ error: string } | { success: true }> {
  await requireAuth();
  const admin = getSupabaseAdminClient();

  const { error } = await admin
    .from("site_content")
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) return { error: error.message };

  revalidatePath("/about");
  revalidatePath("/admin/about");
  return { success: true };
}
