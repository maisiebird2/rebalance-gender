import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import EditForm from "./EditForm";
import type { ArtistWithRelations } from "@/lib/types";

// Always fetch fresh data for admin pages
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}

const ARTIST_ADMIN_SELECT = `
  *,
  pronoun:pronouns(*),
  artist_genres(genres(*)),
  locations:artist_locations(*),
  label_list:artist_labels(*),
  links:artist_links(*),
  enrichment:artist_enrichment(*)
`;

function normalizeArtist(row: any): ArtistWithRelations {
  const genres = (row.artist_genres ?? [])
    .map((ag: any) => ag.genres)
    .filter(Boolean);
  return { ...row, genres };
}

export default async function ArtistEditPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { from } = await searchParams;
  const fromSubmissions = from === "submissions";

  // ── Auth guard ────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/artist/${id}/edit`);
  }

  // ── Load artist (all statuses) and all genres ────────────────
  const admin = getSupabaseAdminClient();
  const [{ data, error }, { data: genreRows }] = await Promise.all([
    admin
      .from("artists")
      .select(ARTIST_ADMIN_SELECT)
      .eq("id", id)
      .maybeSingle(),
    admin.from("genres").select("name").order("name"),
  ]);

  if (error) {
    console.error("Edit page load error:", error);
    notFound();
  }
  if (!data) notFound();

  const artist = normalizeArtist(data);
  const allGenres = (genreRows ?? []).map((g: { name: string }) => g.name);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <Link
          href={fromSubmissions ? "/admin/submissions" : `/artist/${id}`}
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          {fromSubmissions ? "← Back to submissions" : "← Back to artist page"}
        </Link>
      </div>

      <h1 className="mb-6 text-2xl font-bold">
        Editing: {artist.name}
      </h1>

      <EditForm artist={artist} allGenres={allGenres} />
    </div>
  );
}
