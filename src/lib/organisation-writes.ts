// Server-side organisation writes shared by /api/submit and the admin
// approval actions. Everything here takes an already-authorised
// service-role client — none of it does its own auth, so never call it
// from a path that hasn't checked first.
//
// The rule these implement (documentation/ORGANISATIONS.md §7,
// decided 2026-08-23): a submitter can ATTACH an artist to an
// organisation that already exists and is approved, but typing a new
// name does NOT create one. `organisations` is a shared, cross-artist
// namespace with its own public page; letting an unverified submitter
// insert into it means whoever types a name first owns its canonical
// spelling, and rejected submissions leave rows behind that nothing
// links back to.
//
// So a typed name stays in `artist_labels` — the same flat-text row the
// form has always written — and becomes an organisation when an admin
// approves the artist. The artist page dual-reads, so the name is
// visible the whole time either way.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalisedNameKey } from "./name-key.mjs";

/** The role every attachment gets until somebody says otherwise. */
export const DEFAULT_ROLE = "associated";

/** One row as the forms post it: a resolved organisation, or a typed name. */
export interface OrganisationInput {
  id?: string | null;
  name: string;
  /** Only honoured when the caller passes `allowRoles` — see below. */
  role_key?: string;
}

/** A resolved organisation and the role to attach the artist in. */
export interface ResolvedOrganisation {
  organisationId: string;
  roleKey: string;
}

type Admin = SupabaseClient;

/**
 * Split what a form posted into ids that really are approved
 * organisations, and names that aren't.
 *
 * The id is RE-CHECKED here rather than trusted: it arrives from the
 * browser, and between the page rendering its options and the form being
 * posted the organisation can have been rejected, merged or deleted. An
 * id that no longer resolves falls back to being treated as a typed
 * name, so the submission keeps the information instead of dropping it.
 */
export async function resolveOrganisationInputs(
  admin: Admin,
  inputs: OrganisationInput[],
  { allowRoles = false }: { allowRoles?: boolean } = {},
): Promise<{ resolved: ResolvedOrganisation[]; names: string[] }> {
  const cleaned = inputs
    .map((input) => ({
      id: input.id ?? null,
      name: (input.name ?? "").trim(),
      // Roles are ADMIN-ONLY, enforced here rather than in the form: the
      // public submit and revise paths call this without allowRoles, so a
      // hand-edited request claiming role_key='head' still lands as
      // 'associated'. A stranger must not be able to assert that someone
      // runs a label.
      roleKey: allowRoles ? (input.role_key || DEFAULT_ROLE) : DEFAULT_ROLE,
    }))
    .filter((input) => input.name !== "");

  const claimedIds = [...new Set(cleaned.map((c) => c.id).filter((id): id is string => !!id))];

  const approved = new Set<string>();
  if (claimedIds.length > 0) {
    const { data } = await admin
      .from("organisations")
      .select("id")
      .in("id", claimedIds)
      .eq("status", "approved")
      .is("duplicate_of", null);
    for (const row of data ?? []) approved.add(row.id as string);
  }

  const resolved: ResolvedOrganisation[] = [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const input of cleaned) {
    if (input.id && approved.has(input.id)) {
      // (organisation, role) is the unit — the same organisation in two
      // roles is two rows, which is what the composite key allows.
      const pair = `${input.id}|${input.roleKey}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      resolved.push({ organisationId: input.id, roleKey: input.roleKey });
    } else {
      names.push(input.name);
    }
  }
  return { resolved, names };
}

/** Attach an artist to organisations that already exist, in the given roles. */
export async function attachOrganisations(
  admin: Admin,
  artistId: string,
  resolved: ResolvedOrganisation[],
): Promise<void> {
  if (resolved.length === 0) return;
  await admin.from("artist_organisations").upsert(
    resolved.map((r) => ({
      artist_id: artistId,
      organisation_id: r.organisationId,
      role_key: r.roleKey,
    })),
    { onConflict: "artist_id,organisation_id,role_key", ignoreDuplicates: true },
  );
}

/**
 * Find an organisation by normalised name, whatever its status.
 *
 * Status-blind on purpose: reusing a rejected or deleted row is right,
 * because creating a second one with the same name is how you get the
 * duplicate pairs the merge tool exists to clean up. A rejected
 * organisation coming back through a submission should stay rejected,
 * not quietly reappear under a new id.
 */
export async function findOrganisationByName(
  admin: Admin,
  name: string,
): Promise<{ id: string; name: string; status: string } | null> {
  const key = normalisedNameKey(name);
  if (!key) return null;
  const { data } = await admin
    .from("organisations")
    .select("id, name, status")
    .eq("name_search", key)
    .limit(1)
    .maybeSingle();
  return (data as { id: string; name: string; status: string } | null) ?? null;
}

/**
 * Promote an artist's flat `artist_labels` rows into organisations and
 * attach them. Called when an admin approves the artist or a revision.
 *
 * Created organisations are PENDING, not approved. Approving an artist
 * says "this person belongs in the directory", not "this label is
 * correctly named, typed and located" — that is a separate judgement made
 * on /admin/organisations, where the types and links get filled in.
 * Until then the artist page's dual-read keeps showing the flat text, so
 * nothing is lost by waiting.
 *
 * The artist_labels rows are deliberately NOT deleted: they are what the
 * dual-read falls back to while the new organisation is still pending.
 * They go away wholesale in the cleanup phase.
 *
 * Idempotent — findOrganisationByName reuses, and the attach ignores
 * duplicates — so approving twice, or approving an artist whose labels
 * were already converted by the backfill, is a no-op.
 */
export async function promoteArtistLabelsToOrganisations(
  admin: Admin,
  artistId: string,
): Promise<{ created: number; attached: number }> {
  const { data: labelRows } = await admin
    .from("artist_labels")
    .select("name")
    .eq("artist_id", artistId);

  const names = [...new Set(
    (labelRows ?? []).map((r) => (r.name as string).trim()).filter(Boolean),
  )];
  if (names.length === 0) return { created: 0, attached: 0 };

  const ids: string[] = [];
  let created = 0;

  for (const name of names) {
    const existing = await findOrganisationByName(admin, name);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const { data, error } = await admin
      .from("organisations")
      .insert({ name, status: "pending" })
      .select("id")
      .single();
    // One bad name must not abort the approval it is a side effect of —
    // the admin is approving an ARTIST, and the label can be fixed later
    // from the organisations panel.
    if (error || !data) continue;
    ids.push(data.id as string);
    created++;
  }

  await attachOrganisations(
    admin,
    artistId,
    ids.map((organisationId) => ({ organisationId, roleKey: DEFAULT_ROLE })),
  );
  return { created, attached: ids.length };
}
