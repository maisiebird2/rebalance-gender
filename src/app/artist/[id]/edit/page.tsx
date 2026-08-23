// "artist edit" page
// src/app/artist/[id]/edit/page.tsx

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getViewer } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getPlatforms } from "@/lib/platforms";
import EditForm from "./EditForm";
import { getGenrePickerOptions, getOrganisationPickerOptions } from "@/lib/queries";

import type {
  ArtistWithRelations,
  Artist,
  Pronoun,
  Genre,
  ArtistType,
  ArtistLocation,
  ArtistLabel,
  ArtistAlias,
  ArtistLink,
  ArtistEnrichment,
  OrganisationRole,
} from "@/lib/types";

// Always fetch fresh data for admin pages
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}

export async function generateMetadata({ params }: Pick<PageProps, "params">) {
  const { id } = await params;
  const { data } = await getSupabaseAdminClient()
    .from("artists")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  if (!data) return {};
  return {
    title: `${data.name} | Rebalance Gender`,
  };
}

const ARTIST_ADMIN_SELECT = `
  *,
  pronoun:pronouns(*),
  artist_genres(genres(*)),
  artist_type_assignments(source, artist_types(*)),
  locations:artist_locations(*),
  label_list:artist_labels(*),
  artist_organisations(
    role:organisation_roles(key, label, sort_order),
    organisation:organisations(id, name, status)
  ),
  aliases:artist_aliases(*),
  links:artist_links(*),
  enrichment:artist_enrichment(*)
`;

type RawArtistRow = Artist & {
  pronoun: Pronoun | null;
  artist_genres: { genres: Genre | null }[];
  artist_type_assignments: { source: string; artist_types: ArtistType | null }[];
  locations: ArtistLocation[];
  label_list: ArtistLabel[];
  artist_organisations: {
    role: OrganisationRole | null;
    organisation: { id: string; name: string; status: string } | null;
  }[];
  aliases: ArtistAlias[];
  links: ArtistLink[];
  enrichment: ArtistEnrichment[];
};

function normalizeArtist(row: RawArtistRow): ArtistWithRelations {
  const genres = (row.artist_genres ?? [])
    .map((ag) => ag.genres)
    .filter((g): g is Genre => Boolean(g));
  // Unlike the public read path this keeps organisations of EVERY status:
  // the edit form is admin-only, and an admin editing an artist should see
  // the pending organisation they are already attached to rather than have
  // it silently reappear as an unresolved name.
  const organisations = (row.artist_organisations ?? []).flatMap((ao) =>
    ao.role && ao.organisation
      ? [{ organisation: { id: ao.organisation.id, name: ao.organisation.name }, role: ao.role }]
      : []
  );
  return { ...row, genres, organisations } as unknown as ArtistWithRelations;
}

export default async function ArtistEditPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { from } = await searchParams;
  const fromSubmissions = from === "admin" || from === "submissions";

  // ── Auth guard ────────────────────────────────────────────────
  // Admins only: this page loads artists in any status through the
  // service-role client, so a mere session must not be enough to see it.
  const { user, isAdmin } = await getViewer();

  if (!user) {
    redirect(`/login?next=/artist/${id}/edit`);
  }
  if (!isAdmin) {
    redirect("/");
  }

  // ── Load artist (all statuses), selected genres, and all platforms ──
  const admin = getSupabaseAdminClient();
  const [{ data, error }, genreOptions, organisationOptions, platforms, { data: typeRows }] =
    await Promise.all([
      admin
        .from("artists")
        .select(ARTIST_ADMIN_SELECT)
        .eq("id", id)
        .maybeSingle(),
      getGenrePickerOptions(),
      getOrganisationPickerOptions(),
      getPlatforms(admin),
      admin.from("artist_types").select("name, label, sort_order").order("sort_order"),
    ]);

  if (error) {
    console.error("Edit page load error:", error);
    notFound();
  }
  if (!data) notFound();

  const artist = normalizeArtist(data);

  // The full type vocabulary (producer / DJ / vocalist), for the checkboxes.
  const typeOptions = ((typeRows ?? []) as { name: string; label: string }[]).map(
    (t) => ({ name: t.name, label: t.label })
  );

  // Prefill the checkboxes with the artist's MANUAL types only. Rows from other
  // sources (e.g. a future harvester) are owned by that source and aren't
  // editable here, so the form leaves them alone on save.
  const initialTypes = Array.from(
    new Set(
      ((data as unknown as RawArtistRow).artist_type_assignments ?? [])
        .filter((ta) => ta.source === "manual" && ta.artist_types)
        .map((ta) => ta.artist_types!.name)
    )
  );

  // Name of the stored duplicate_of target, so the form can show which entry
  // the saved ID refers to without the admin having to open it. Queried
  // separately rather than embedded in ARTIST_ADMIN_SELECT: a self-join on
  // the FK would make this page fail outright if the column is ever missing
  // (e.g. before supabase_migration_artist_duplicate_of.sql is applied).
  let duplicateOfName: string | null = null;
  if (artist.duplicate_of) {
    const { data: target } = await admin
      .from("artists")
      .select("name")
      .eq("id", artist.duplicate_of)
      .maybeSingle();
    duplicateOfName = target?.name ?? null;
  }


  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <Link
          href={fromSubmissions ? "/admin" : `/artist/${id}`}
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          {fromSubmissions ? "← Back to admin panel" : "← Back to artist page"}
        </Link>
      </div>

      <h1 className="mb-6 text-2xl font-bold">
        Editing: {artist.name}
      </h1>

      <EditForm
        artist={artist}
        genreOptions={genreOptions}
        organisationOptions={organisationOptions}
        typeOptions={typeOptions}
        initialTypes={initialTypes}
        platforms={platforms}
        duplicateOfName={duplicateOfName}
      />
    </div>
  );
}
