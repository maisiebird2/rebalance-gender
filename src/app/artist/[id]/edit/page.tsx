import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getPlatforms } from "@/lib/platforms";
import EditForm from "./EditForm";
import type {
  ArtistWithRelations,
  Artist,
  Pronoun,
  Genre,
  ArtistLocation,
  ArtistLabel,
  ArtistLink,
  ArtistEnrichment,
} from "@/lib/types";

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

type RawArtistRow = Artist & {
  pronoun: Pronoun | null;
  artist_genres: { genres: Genre | null }[];
  locations: ArtistLocation[];
  label_list: ArtistLabel[];
  links: ArtistLink[];
  enrichment: ArtistEnrichment[];
};

function normalizeArtist(row: RawArtistRow): ArtistWithRelations {
  const genres = (row.artist_genres ?? [])
    .map((ag) => ag.genres)
    .filter((g): g is Genre => Boolean(g));
  return { ...row, genres } as unknown as ArtistWithRelations;
}

export default async function ArtistEditPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { from } = await searchParams;
  const fromSubmissions = from === "admin" || from === "submissions";

  // ── Auth guard ────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/artist/${id}/edit`);
  }

  // ── Load artist (all statuses), all genres, and all platforms ──
  const admin = getSupabaseAdminClient();
  const [{ data, error }, { data: genreRows }, platforms] = await Promise.all([
    admin
      .from("artists")
      .select(ARTIST_ADMIN_SELECT)
      .eq("id", id)
      .maybeSingle(),
    admin.from("genres").select("name").neq("status", "deleted").order("name"),
    getPlatforms(admin),
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
          href={fromSubmissions ? "/admin" : `/artist/${id}`}
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          {fromSubmissions ? "← Back to admin panel" : "← Back to artist page"}
        </Link>
      </div>

      <h1 className="mb-6 text-2xl font-bold">
        Editing: {artist.name}
      </h1>

      <EditForm artist={artist} allGenres={allGenres} platforms={platforms} />
    </div>
  );
}
