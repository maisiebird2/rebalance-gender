"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { isAdminUser } from "@/lib/admin-auth";
import { scrapeArtistImages, SCRAPE_ONLY_PLATFORMS } from "@/lib/scrape-images";

async function requireAuth() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");
  return user;
}

// Every action in this file needs more than a session: the signed-in user
// must be an admin (see src/lib/admin-auth.ts). Non-admins are bounced to
// the homepage (the panel UI that calls these is itself admin-only, so
// this only triggers on direct/stale invocations). Public sign-up may be
// enabled on the Supabase project, so "has an account" must never be
// treated as "is an admin" — a bare requireAuth() is not enough for
// anything that writes through the service-role client.
async function requireAdmin() {
  const user = await requireAuth();
  if (!isAdminUser(user)) redirect("/");
}

// ── Submission moderation ──────────────────────────────────────────

export async function quickApprove(id: string): Promise<{ error: string } | void> {
  await requireAdmin();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "approved" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  // Run image enrichment in the background after the response is sent.
  // This is the moment images become allowed for this artist at all
  // (scrapeArtistImages only ever acts on directory_status = 'approved'),
  // so check every scrape-owned platform link they have. soundcloud and
  // bandcamp are deliberately excluded — their own harvesters pick this
  // artist up on the next orchestrator run.
  after(() => scrapeArtistImages(id, admin, { allowedPlatforms: SCRAPE_ONLY_PLATFORMS }));
}

export async function quickReject(id: string): Promise<{ error: string } | void> {
  await requireAdmin();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "rejected" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
}

export async function quickMarkNotEligible(id: string): Promise<{ error: string } | void> {
  await requireAdmin();
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

export async function quickApproveArtist(id: string): Promise<{ error: string } | void> {
  await requireAdmin();
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artists")
    .update({ directory_status: "approved" })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath(`/artist/${id}`);
  // Same as quickApprove: approval is the moment images become allowed for
  // this artist, so kick off enrichment after the response is sent.
  after(() => scrapeArtistImages(id, admin, { allowedPlatforms: SCRAPE_ONLY_PLATFORMS }));
}

// ── Genres ──────────────────────────────────────────────────────────

export async function addGenre(
  formData: FormData
): Promise<{ error: string } | { success: true }> {
  await requireAdmin();

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
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
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

// ── Genre tag rules ─────────────────────────────────────────────────
// The harvest normalisation vocabulary (genre_tag_rules): alias
// spellings → canonical names, discard rules for non-genre tags, and
// word fixes. Read at startup by the harvest scripts via
// scripts/lib/genre-vocab.mjs; rules only affect future script runs,
// so no public pages need revalidating here.

const GENRE_TAG_RULE_KINDS = ["alias", "discard", "word_fix"] as const;
export type GenreTagRuleKind = (typeof GENRE_TAG_RULE_KINDS)[number];

export async function addGenreTagRule(
  formData: FormData
): Promise<{ error: string } | { success: true }> {
  await requireAdmin();

  const kind = ((formData.get("kind") ?? "") as string).trim();
  if (!(GENRE_TAG_RULE_KINDS as readonly string[]).includes(kind)) {
    return { error: "Invalid rule kind" };
  }

  // Stored lowercase — the scripts lowercase incoming tags before lookup,
  // and the table CHECK constraint rejects anything else.
  const rawTag = ((formData.get("raw_tag") ?? "") as string).trim().toLowerCase();
  if (!rawTag) return { error: "Raw tag is required" };

  const canonical = ((formData.get("canonical") ?? "") as string).trim();
  if (kind !== "discard" && !canonical) {
    return { error: "Canonical name is required for alias and word-fix rules" };
  }

  const note = ((formData.get("note") ?? "") as string).trim();

  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("genre_tag_rules").insert({
    kind,
    raw_tag: rawTag,
    canonical: kind === "discard" ? null : canonical,
    note: note || null,
  });
  if (error) {
    if (error.code === "23505") {
      return { error: `A ${kind} rule for "${rawTag}" already exists` };
    }
    return { error: error.message };
  }

  revalidatePath("/admin/settings");
  return { success: true };
}

export async function deleteGenreTagRule(
  id: number
): Promise<{ error: string } | void> {
  await requireAdmin();
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("genre_tag_rules").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin/settings");
}

// ── Revision moderation ────────────────────────────────────────────────

export async function approveRevision(
  revisionId: string
): Promise<{ error: string } | void> {
  await requireAdmin();
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
    const { resolveProfileLinkUrl } = await import("@/lib/profile-links");
    const rows = Object.entries(rd.links)
      .filter(([, url]) => url?.trim())
      .map(([platform, url]) => ({
        artist_id: artistId,
        platform,
        original_url: url.trim(),
        url: resolveProfileLinkUrl(platform, url.trim()),
      }));
    if (rows.length) {
      await admin.from("artist_links").upsert(rows, { onConflict: "artist_id,platform" });
      // Shortener/share links are followed after the response — see
      // scheduleLinkResolution. This is where a *revision's* links land: the
      // revise route only stores revision_data, so an approved revision is
      // the first moment its links become real rows.
      const { scheduleLinkResolution } = await import("@/lib/schedule-link-resolution");
      scheduleLinkResolution(admin, artistId);
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
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();

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
  await requireAdmin();
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

// ── Organisation vocabularies (roles and types) ──────────────────────
//
// organisation_roles says what an artist IS at an organisation ('head',
// 'resident', 'A&R'); organisation_types says what the organisation IS
// ('record label', 'club'). Both are lookup tables rather than Postgres
// enums for the same reason `platforms` is one — "distributor" can be
// added here without a code change — and both are seeded by
// supabase_migration_organisations.sql, so an empty table means rows
// were deleted, not that setup is pending.
//
// These go beyond addPlatform() in two ways, because role wording needs
// correcting more often than platform wording does:
//
//   rename  edits `label` in place and leaves `key` alone, so every row
//           already pointing at the key follows along ("A&R" typed as
//           "AR" is a one-field fix, not a migration).
//   delete  refuses when the vocabulary entry is in use. The FK is ON
//           DELETE RESTRICT so the database would refuse anyway; this
//           counts the blockers first and says how many there are,
//           instead of surfacing a raw Postgres error.

const ORGANISATION_VOCABULARIES = {
  role: {
    table: "organisation_roles",
    usageTable: "artist_organisations",
    usageColumn: "role_key",
    noun: "role",
  },
  type: {
    table: "organisation_types",
    usageTable: "organisation_type_links",
    usageColumn: "type_key",
    noun: "type",
  },
} as const;

export type OrganisationVocabulary = keyof typeof ORGANISATION_VOCABULARIES;

function organisationVocabularyPaths() {
  revalidatePath("/admin/settings");
  revalidatePath("/admin/organisations");
}

export async function addOrganisationVocabularyEntry(
  kind: OrganisationVocabulary,
  formData: FormData,
): Promise<{ error: string } | { success: true }> {
  await requireAdmin();

  const spec = ORGANISATION_VOCABULARIES[kind];
  if (!spec) return { error: "Invalid vocabulary" };

  const label = ((formData.get("label") ?? "") as string).trim();
  if (!label) return { error: `${spec.noun[0].toUpperCase()}${spec.noun.slice(1)} name is required` };

  // Same slugify() the platform keys use, so keys read alike across the
  // lookup tables.
  const key = slugify(label);
  if (!key) return { error: "Couldn't derive a key from that name — try adding a letter or number" };

  const admin = getSupabaseAdminClient();

  const { data: existing } = await admin
    .from(spec.table)
    .select("key")
    .eq("key", key)
    .maybeSingle();
  if (existing) return { error: `"${label}" already exists` };

  const { data: maxRow } = await admin
    .from(spec.table)
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await admin
    .from(spec.table)
    .insert({ key, label, sort_order: (maxRow?.sort_order ?? 0) + 10 });
  if (error) return { error: error.message };

  organisationVocabularyPaths();
  return { success: true };
}

export async function renameOrganisationVocabularyEntry(
  kind: OrganisationVocabulary,
  key: string,
  label: string,
): Promise<{ error: string } | { success: true }> {
  await requireAdmin();

  const spec = ORGANISATION_VOCABULARIES[kind];
  if (!spec) return { error: "Invalid vocabulary" };

  const trimmed = label.trim();
  if (!trimmed) return { error: "Name can't be empty" };

  // Only `label` moves. Renaming the key would orphan every row using it,
  // which is exactly what this is here to avoid.
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from(spec.table).update({ label: trimmed }).eq("key", key);
  if (error) return { error: error.message };

  organisationVocabularyPaths();
  return { success: true };
}

export async function deleteOrganisationVocabularyEntry(
  kind: OrganisationVocabulary,
  key: string,
): Promise<{ error: string } | { success: true }> {
  await requireAdmin();

  const spec = ORGANISATION_VOCABULARIES[kind];
  if (!spec) return { error: "Invalid vocabulary" };

  const admin = getSupabaseAdminClient();

  const { count, error: countErr } = await admin
    .from(spec.usageTable)
    .select("*", { count: "exact", head: true })
    .eq(spec.usageColumn, key);
  if (countErr) return { error: countErr.message };

  if ((count ?? 0) > 0) {
    return {
      error: `Still in use by ${count} association${count === 1 ? "" : "s"} — reassign those first.`,
    };
  }

  const { error } = await admin.from(spec.table).delete().eq("key", key);
  if (error) return { error: error.message };

  organisationVocabularyPaths();
  return { success: true };
}
