"use server";

// Server actions for /admin/organisations — phase 3 of
// documentation/ORGANISATIONS.md.
//
// Every action here writes (or reads any-status data) through the
// service-role client, so each is gated on ADMIN_EMAILS membership rather
// than on merely having a session: public sign-up may be enabled on the
// Supabase project, so "has an account" is not "is an admin".
//
// Errors are returned as objects rather than thrown, so the client
// components can surface them inline.

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { deriveHandle, resolveProfileLinkUrl } from "@/lib/profile-links";
import { normalisedNameKey } from "@/lib/name-key.mjs";
import type { LinkPlatform, OrganisationStatus } from "@/lib/types";

const ORGANISATION_STATUSES: OrganisationStatus[] = [
  "pending",
  "approved",
  "rejected",
  "deleted",
];

interface LinkInput {
  platform: LinkPlatform;
  url: string | null;
  not_found?: boolean;
}

interface LocationInput {
  city?: string;
  country?: string;
}

async function requireAdminForAction(): Promise<{ error: string } | null> {
  const { user, isAdmin } = await getViewer();
  if (!user) return { error: "Not authenticated" };
  if (!isAdmin) return { error: "Not authorized" };
  return null;
}

// Every write touches the list, and most touch one detail page. Public
// pages don't read organisations yet (that is phase 4), so nothing else
// needs busting.
function revalidateOrganisation(id?: string) {
  revalidatePath("/admin/organisations");
  if (id) revalidatePath(`/admin/organisations/${id}`);
}

function parseJson<T>(raw: FormDataEntryValue | null, fallback: T): T | null {
  if (raw === null) return fallback;
  try {
    return JSON.parse((raw as string) || "null") ?? fallback;
  } catch {
    return null;
  }
}

// ── Create ───────────────────────────────────────────────────────────

/**
 * Create an organisation from the list page's one-field form.
 *
 * Admin-created organisations are approved immediately — someone is
 * looking at it right now, which is the whole point of the pending
 * state. (The backfill and, later, public submissions create `pending`
 * rows instead.)
 *
 * Refuses a name that normalises to one already present, whatever its
 * status: that is exactly the "Ostgut Ton" / "ostgut-ton" case the merge
 * tool exists to clean up, and it is cheaper not to create it.
 */
export async function createOrganisation(
  formData: FormData,
): Promise<{ error: string } | { success: true; id: string }> {
  const authError = await requireAdminForAction();
  if (authError) return authError;

  const name = ((formData.get("name") ?? "") as string).trim();
  if (!name) return { error: "Name is required" };

  const admin = getSupabaseAdminClient();

  const duplicate = await findByNormalisedName(admin, name);
  if (duplicate) {
    return {
      error: `“${duplicate.name}” already exists (${duplicate.status}) — edit that one, or merge afterwards.`,
    };
  }

  const { data, error } = await admin
    .from("organisations")
    .insert({ name, status: "approved" })
    .select("id")
    .single();
  if (error) return { error: error.message };

  revalidateOrganisation(data.id as string);
  return { success: true, id: data.id as string };
}

/**
 * Look up an organisation by the same normalised key Postgres stores in
 * name_search, so "Ostgut Ton", "ostgut ton" and "ostgut-ton" all find
 * each other. Filtering on name_search works because it is one of the
 * columns the public grant keeps readable, and the service role reads
 * everything regardless.
 */
async function findByNormalisedName(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  name: string,
  excludeId?: string,
): Promise<{ id: string; name: string; status: OrganisationStatus } | null> {
  const key = normalisedNameKey(name);
  if (!key) return null;

  let query = admin
    .from("organisations")
    .select("id, name, status")
    .eq("name_search", key);
  if (excludeId) query = query.neq("id", excludeId);

  const { data } = await query.limit(1).maybeSingle();
  return (data as { id: string; name: string; status: OrganisationStatus } | null) ?? null;
}

// ── Update ───────────────────────────────────────────────────────────

/**
 * Save the whole detail form: the organisation row plus its types,
 * locations and links.
 *
 * Types / locations / links are delete-then-reinsert, the same shape
 * saveArtist() uses — the form owns the complete set, so a replace is
 * both simpler and correct.
 */
export async function saveOrganisation(
  formData: FormData,
): Promise<{ error: string } | { success: true }> {
  const authError = await requireAdminForAction();
  if (authError) return authError;

  const id = ((formData.get("id") ?? "") as string).trim();
  const name = ((formData.get("name") ?? "") as string).trim();
  if (!id || !name) return { error: "Missing required fields" };

  const status = (formData.get("status") ?? "pending") as OrganisationStatus;
  if (!ORGANISATION_STATUSES.includes(status)) return { error: "Invalid status" };

  const description = ((formData.get("description") ?? "") as string).trim() || null;
  const runByText = ((formData.get("run_by_text") ?? "") as string).trim() || null;
  const notes = ((formData.get("notes") ?? "") as string).trim() || null;

  const typeKeys = parseJson<string[]>(formData.get("types"), []);
  if (!typeKeys) return { error: "Invalid types data" };
  const locations = parseJson<LocationInput[]>(formData.get("locations"), []);
  if (!locations) return { error: "Invalid locations data" };
  const links = parseJson<LinkInput[]>(formData.get("links"), []);
  if (!links) return { error: "Invalid links data" };

  const admin = getSupabaseAdminClient();

  const clash = await findByNormalisedName(admin, name, id);
  if (clash) {
    return {
      error: `That name collides with “${clash.name}” (${clash.status}) — merge them instead of having two.`,
    };
  }

  const { error: orgErr } = await admin
    .from("organisations")
    .update({ name, status, description, run_by_text: runByText, notes })
    .eq("id", id);
  if (orgErr) return { error: `Save error: ${orgErr.message}` };

  // ── Types ──────────────────────────────────────────────────────
  await admin.from("organisation_type_links").delete().eq("organisation_id", id);
  const keys = typeKeys.filter(Boolean);
  if (keys.length > 0) {
    const { error } = await admin
      .from("organisation_type_links")
      .insert(keys.map((type_key) => ({ organisation_id: id, type_key })));
    // A key outside the vocabulary is a bug in the form, and the FK
    // catches it — say which one rather than passing the raw error on.
    if (error) return { error: `Types save error: ${error.message}` };
  }

  // ── Locations ──────────────────────────────────────────────────
  await admin.from("organisation_locations").delete().eq("organisation_id", id);
  const validLocations = locations.filter((l) => l.city || l.country);
  if (validLocations.length > 0) {
    const { error } = await admin.from("organisation_locations").insert(
      validLocations.map((l) => ({
        organisation_id: id,
        city: l.city?.trim() || null,
        country: l.country?.trim() || null,
      })),
    );
    if (error) return { error: `Location error: ${error.message}` };
  }

  // ── Links ──────────────────────────────────────────────────────
  // Same canonicalisation the artist edit form applies, so an
  // organisation's SoundCloud URL is stored in the same shape as an
  // artist's. No async redirect-following here: organisation links are
  // typed by an admin one at a time, not harvested in bulk.
  await admin.from("organisation_links").delete().eq("organisation_id", id);
  const validLinks = links.filter((l) => l.not_found || l.url?.trim());
  if (validLinks.length > 0) {
    const { error } = await admin.from("organisation_links").insert(
      validLinks.map((l) => {
        if (l.not_found) {
          return {
            organisation_id: id,
            platform: l.platform,
            handle: null,
            url: null,
            not_found: true,
          };
        }
        const original_url = l.url!.trim();
        const url = resolveProfileLinkUrl(l.platform, original_url);
        return {
          organisation_id: id,
          platform: l.platform,
          handle: deriveHandle(l.platform, url),
          url,
          original_url,
          not_found: false,
        };
      }),
    );
    if (error) return { error: `Links save error: ${error.message}` };
  }

  revalidateOrganisation(id);
  return { success: true };
}

// ── Moderation ───────────────────────────────────────────────────────

/** Approve / reject / soft-delete / re-queue one organisation. */
export async function setOrganisationStatus(
  id: string,
  status: OrganisationStatus,
): Promise<{ error: string } | { success: true }> {
  const authError = await requireAdminForAction();
  if (authError) return authError;
  if (!ORGANISATION_STATUSES.includes(status)) return { error: "Invalid status" };

  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("organisations").update({ status }).eq("id", id);
  if (error) return { error: error.message };

  revalidateOrganisation(id);
  return { success: true };
}

/**
 * Bulk-approve the pending queue — the backfill creates ~208 rows at once
 * and clicking through them individually is not a review, it is RSI.
 * Scoped to the ids the panel is actually showing, so a filtered view
 * approves what it displays and nothing else.
 */
export async function approveOrganisations(
  ids: string[],
): Promise<{ error: string } | { success: true; count: number }> {
  const authError = await requireAdminForAction();
  if (authError) return authError;
  if (ids.length === 0) return { success: true, count: 0 };

  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("organisations")
    .update({ status: "approved" })
    .in("id", ids);
  if (error) return { error: error.message };

  revalidateOrganisation();
  return { success: true, count: ids.length };
}

// ── Merge ────────────────────────────────────────────────────────────

/**
 * Fold `loserId` into `winnerId`: move every association across, point
 * duplicate_of at the winner, and mark the loser deleted.
 *
 * This is the action that matters long-term — free-text entry will keep
 * producing "Ostgut Ton" / "ostgut-ton" pairs, and without a merge the
 * only alternative is losing the associations on one of them.
 *
 * The loser's own rows (types, locations, links) are deliberately left
 * where they are rather than merged in: the winner has its own curated
 * set, and silently mixing two link lists produces a row nobody chose.
 * The loser stays readable at its own admin URL, so anything worth
 * keeping can be copied across by hand first.
 */
export async function mergeOrganisations(
  loserId: string,
  winnerId: string,
): Promise<{ error: string } | { success: true; moved: number }> {
  const authError = await requireAdminForAction();
  if (authError) return authError;

  if (!loserId || !winnerId) return { error: "Both organisations are required" };
  if (loserId === winnerId) return { error: "An organisation can't be merged into itself" };

  const admin = getSupabaseAdminClient();

  const { data: winner, error: winnerErr } = await admin
    .from("organisations")
    .select("id, name, status, duplicate_of")
    .eq("id", winnerId)
    .maybeSingle();
  if (winnerErr) return { error: `Lookup failed: ${winnerErr.message}` };
  if (!winner) return { error: "No organisation found with that ID" };
  // Chains would make every reader walk the pointer, so the target must
  // be a real entry — the same rule artists.duplicate_of follows.
  if (winner.duplicate_of) {
    return { error: `“${winner.name}” is itself merged into another organisation — point at the one being kept.` };
  }
  if (winner.status === "deleted") {
    return { error: `“${winner.name}” is deleted — merge into the entry being kept.` };
  }

  // Move the associations. artist_organisations is keyed
  // (artist_id, organisation_id, role_key), so an artist already attached
  // to the winner in the same role would collide on update — re-insert
  // with ignoreDuplicates and then drop the loser's rows instead.
  const { data: associations, error: assocErr } = await admin
    .from("artist_organisations")
    .select("artist_id, role_key")
    .eq("organisation_id", loserId);
  if (assocErr) return { error: `Associations lookup failed: ${assocErr.message}` };

  const rows = associations ?? [];
  if (rows.length > 0) {
    const { error } = await admin.from("artist_organisations").upsert(
      rows.map((r) => ({
        artist_id: r.artist_id as string,
        organisation_id: winnerId,
        role_key: r.role_key as string,
      })),
      { onConflict: "artist_id,organisation_id,role_key", ignoreDuplicates: true },
    );
    if (error) return { error: `Association move failed: ${error.message}` };

    const { error: delErr } = await admin
      .from("artist_organisations")
      .delete()
      .eq("organisation_id", loserId);
    if (delErr) return { error: `Association cleanup failed: ${delErr.message}` };
  }

  // Anything that was already merged into the loser follows it across,
  // so no pointer is left aiming at a deleted row.
  await admin
    .from("organisations")
    .update({ duplicate_of: winnerId })
    .eq("duplicate_of", loserId);

  const { error: markErr } = await admin
    .from("organisations")
    .update({ duplicate_of: winnerId, status: "deleted" })
    .eq("id", loserId);
  if (markErr) return { error: `Merge failed: ${markErr.message}` };

  revalidateOrganisation(loserId);
  revalidateOrganisation(winnerId);
  return { success: true, moved: rows.length };
}

// ── Artist associations ──────────────────────────────────────────────

/**
 * Attach an artist to this organisation in one role.
 *
 * role_key is part of the primary key, so adding a second role for the
 * same artist is an ordinary insert, not an update — that is how someone
 * ends up correctly listed as both owner and resident.
 */
export async function addArtistAssociation(
  organisationId: string,
  artistId: string,
  roleKey: string,
): Promise<{ error: string } | { success: true }> {
  const authError = await requireAdminForAction();
  if (authError) return authError;
  if (!organisationId || !artistId || !roleKey) return { error: "Missing required fields" };

  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("artist_organisations").upsert(
    { artist_id: artistId, organisation_id: organisationId, role_key: roleKey },
    { onConflict: "artist_id,organisation_id,role_key", ignoreDuplicates: true },
  );
  if (error) return { error: error.message };

  revalidateOrganisation(organisationId);
  return { success: true };
}

export async function removeArtistAssociation(
  organisationId: string,
  artistId: string,
  roleKey: string,
): Promise<{ error: string } | { success: true }> {
  const authError = await requireAdminForAction();
  if (authError) return authError;

  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from("artist_organisations")
    .delete()
    .eq("organisation_id", organisationId)
    .eq("artist_id", artistId)
    .eq("role_key", roleKey);
  if (error) return { error: error.message };

  revalidateOrganisation(organisationId);
  return { success: true };
}

/**
 * Typeahead for the "add an artist" picker. Matches the same normalised
 * key the directory search uses, so punctuation and accents don't have to
 * be typed exactly.
 */
export async function searchArtistsForAssociation(
  term: string,
): Promise<{ id: string; name: string; directory_status: string }[]> {
  const authError = await requireAdminForAction();
  if (authError) return [];

  const key = normalisedNameKey(term);
  if (!key) return [];

  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("artists")
    .select("id, name, directory_status")
    .eq("deleted", false)
    .ilike("name_search", `%${key}%`)
    .order("name")
    .limit(20);

  return (data ?? []) as { id: string; name: string; directory_status: string }[];
}
