import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import SubmissionsPanel, { type SubmissionItem } from "./SubmissionsPanel";
import type {
  ArtistWithRelations,
  ArtistRevision,
  Artist,
  Pronoun,
  Genre,
  ArtistLocation,
  ArtistLabel,
  ArtistLink,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const SUBMISSION_SELECT = `
  *,
  pronoun:pronouns(*),
  artist_genres(genres(*)),
  locations:artist_locations(*),
  label_list:artist_labels(*),
  links:artist_links(*)
`;

type RawSubmissionRow = Artist & {
  pronoun: Pronoun | null;
  artist_genres: { genres: Genre | null }[];
  locations: ArtistLocation[];
  label_list: ArtistLabel[];
  links: ArtistLink[];
};

function normalizeArtist(row: RawSubmissionRow): ArtistWithRelations {
  const genres = (row.artist_genres ?? [])
    .map((ag) => ag.genres)
    .filter((g): g is Genre => Boolean(g));
  return { ...row, genres } as unknown as ArtistWithRelations;
}

export default async function AdminPage() {
  // ── Auth guard ────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");

  const admin = getSupabaseAdminClient();

  const [
    { data: submissionRows, error },
    { data: searchInputRows },
    { data: revisionRows },
  ] = await Promise.all([
    admin.from("artists").select(SUBMISSION_SELECT)
      .eq("directory_status", "pending").eq("deleted", false)
      .order("created_at", { ascending: true }),
    admin.from("artists").select(SUBMISSION_SELECT)
      .eq("directory_status", "search_input").eq("deleted", false)
      .order("created_at", { ascending: true }),
    admin.from("artist_revisions").select(`
      *,
      artist:artists(id, name, directory_status)
    `).eq("status", "pending").order("created_at", { ascending: true }),
  ]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 text-red-600">
        Error loading submissions: {error.message}
      </div>
    );
  }

  const submissions: ArtistWithRelations[] = (submissionRows ?? []).map(normalizeArtist);
  const searchInputs: ArtistWithRelations[] = (searchInputRows ?? []).map(normalizeArtist);
  const revisions = (revisionRows ?? []) as (ArtistRevision & { artist: { id: string; name: string } })[];

  // ── Combine everything that needs review into one sorted list ──────────
  const items: SubmissionItem[] = [
    ...submissions.map((artist) => ({
      kind: "submission" as const,
      sortDate: artist.submitted_at ?? artist.created_at,
      artist,
    })),
    ...searchInputs.map((artist) => ({
      kind: "search_input" as const,
      sortDate: artist.submitted_at ?? artist.created_at,
      artist,
    })),
    ...revisions.map((revision) => ({
      kind: "revision" as const,
      sortDate: revision.created_at,
      revision,
    })),
  ].sort((a, b) => new Date(a.sortDate).getTime() - new Date(b.sortDate).getTime());

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin panel</h1>
        <div className="flex items-center gap-4">
          <Link href="/admin/missing-links" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
            Missing links →
          </Link>
          <Link href="/admin/settings" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
            Genres, links &amp; emails →
          </Link>
          <Link href="/" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
            ← Directory
          </Link>
        </div>
      </div>

      <SubmissionsPanel items={items} />
    </div>
  );
}
