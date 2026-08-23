import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getViewer } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase";
import NotAdminNotice from "@/components/NotAdminNotice";
import type {
  Organisation,
  OrganisationLink,
  OrganisationLocation,
  OrganisationRole,
  OrganisationType,
  Platform,
} from "@/lib/types";
import OrganisationEditForm from "../OrganisationEditForm";
import ArtistAssociationsPanel, { type AssociationRow } from "../ArtistAssociationsPanel";
import MergeOrganisationForm from "../MergeOrganisationForm";

export const dynamic = "force-dynamic";

export default async function AdminOrganisationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const { user, isAdmin } = await getViewer();
  if (!user) redirect(`/login?next=/admin/organisations/${id}`);
  if (!isAdmin) return <NotAdminNotice />;

  const admin = getSupabaseAdminClient();

  // Service-role read, so `notes` comes back — the public roles have no
  // grant on that column (see the column-grant block in
  // supabase_migration_organisations.sql) and it is never rendered
  // outside this panel.
  const { data: organisation } = await admin
    .from("organisations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!organisation) notFound();
  const org = organisation as Organisation;

  const [
    { data: typeLinkRows },
    { data: locationRows },
    { data: linkRows },
    { data: associationRows },
    { data: typeRows },
    { data: roleRows },
    { data: platformRows },
    { data: mergeTargetRows },
    { data: duplicateRow },
  ] = await Promise.all([
    admin.from("organisation_type_links").select("type_key").eq("organisation_id", id),
    admin
      .from("organisation_locations")
      .select("id, organisation_id, city, country")
      .eq("organisation_id", id)
      .order("id"),
    admin
      .from("organisation_links")
      .select("id, organisation_id, platform, handle, url, original_url, not_found")
      .eq("organisation_id", id),
    admin
      .from("artist_organisations")
      .select("artist_id, role_key, artists(id, name, directory_status)")
      .eq("organisation_id", id),
    admin.from("organisation_types").select("key, label, sort_order").order("sort_order"),
    admin.from("organisation_roles").select("key, label, sort_order").order("sort_order"),
    admin.from("platforms").select("key, label, sort_order, search_url_template").order("sort_order").order("label"),
    admin
      .from("organisations")
      .select("id, name, status")
      .neq("id", id)
      .is("duplicate_of", null)
      .neq("status", "deleted")
      .order("name")
      .limit(1000),
    org.duplicate_of
      ? admin.from("organisations").select("id, name").eq("id", org.duplicate_of).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const roles = (roleRows ?? []) as OrganisationRole[];
  const roleLabel = new Map(roles.map((r) => [r.key, r.label]));

  const associations: AssociationRow[] = ((associationRows ?? []) as unknown as {
    artist_id: string;
    role_key: string;
    artists: { id: string; name: string; directory_status: string } | null;
  }[])
    .map((row) => ({
      artist_id: row.artist_id,
      artist_name: row.artists?.name ?? row.artist_id,
      artist_status: row.artists?.directory_status ?? "unknown",
      role_key: row.role_key,
      role_label: roleLabel.get(row.role_key) ?? row.role_key,
    }))
    .sort((a, b) => a.artist_name.localeCompare(b.artist_name) || a.role_key.localeCompare(b.role_key));

  const duplicateTarget = duplicateRow as { id: string; name: string } | null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{org.name}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{org.status}</p>
        </div>
        <Link
          href="/admin/organisations"
          className="shrink-0 text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          ← All organisations
        </Link>
      </div>

      {duplicateTarget && (
        <p className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Merged into{" "}
          <Link
            href={`/admin/organisations/${duplicateTarget.id}`}
            className="underline"
          >
            {duplicateTarget.name}
          </Link>
          . Its associations have already moved; this row is kept so nothing
          points at a missing id.
        </p>
      )}

      <div className="flex flex-col gap-8">
        <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
          <h2 className="mb-4 text-lg font-semibold">Details</h2>
          <OrganisationEditForm
            organisation={org}
            selectedTypes={((typeLinkRows ?? []) as { type_key: string }[]).map((t) => t.type_key)}
            locations={(locationRows ?? []) as OrganisationLocation[]}
            links={(linkRows ?? []) as OrganisationLink[]}
            types={(typeRows ?? []) as OrganisationType[]}
            platforms={(platformRows ?? []) as Platform[]}
          />
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
          <h2 className="mb-1 text-lg font-semibold">Artists</h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            One row per role, so somebody can be both owner and resident here.
            People who run it but aren&apos;t in the directory go in
            &ldquo;Run by&rdquo; above instead.
          </p>
          <ArtistAssociationsPanel
            organisationId={org.id}
            associations={associations}
            roles={roles}
          />
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
          <h2 className="mb-1 text-lg font-semibold">Merge</h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            Fold this organisation into another one: every artist association
            moves across, this row is marked deleted and points at the one
            being kept. Types, locations and links do <em>not</em> move — copy
            anything worth keeping over first.
          </p>
          <MergeOrganisationForm
            organisation={org}
            targets={(mergeTargetRows ?? []) as { id: string; name: string; status: string }[]}
          />
        </section>
      </div>
    </div>
  );
}
