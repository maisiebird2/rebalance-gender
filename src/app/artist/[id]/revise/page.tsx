import { notFound } from "next/navigation";
import { getArtistById } from "@/lib/queries";
import { getPlatforms } from "@/lib/platforms";
import { getSupabaseAdminClient } from "@/lib/supabase";
import RevisionForm from "@/components/RevisionForm";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const artist = await getArtistById(id);
  if (!artist) return {};
  return {
    title: `Suggest a correction for ${artist.name} — Women in Electronic Music`,
  };
}

export default async function RevisePage({ params }: PageProps) {
  const { id } = await params;
  const admin = getSupabaseAdminClient();

  const [artist, platforms, { data: genreRows }] = await Promise.all([
    getArtistById(id),
    getPlatforms(admin),
    admin.from("genres").select("name").order("name"),
  ]);

  if (!artist || artist.directory_status !== "approved") notFound();

  const allGenres = (genreRows ?? []).map((g: { name: string }) => g.name);

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <a
        href={`/artist/${id}`}
        className="mb-4 inline-block text-sm text-violet-600 hover:underline dark:text-violet-400"
      >
        ← Back to {artist.name}
      </a>
      <h1 className="mb-2 text-2xl font-bold">Suggest a correction</h1>
      <p className="mb-6 text-gray-600 dark:text-gray-400">
        Spotted something wrong or out of date? Update the fields below and
        we'll review your suggested changes.
      </p>
      <RevisionForm artist={artist} allGenres={allGenres} platforms={platforms} />
    </div>
  );
}
