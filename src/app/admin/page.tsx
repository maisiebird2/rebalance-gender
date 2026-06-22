import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { quickApprove, quickReject } from "./actions";
import AddGenreForm from "./AddGenreForm";
import AddPlatformForm from "./AddPlatformForm";
import type { ArtistWithRelations } from "@/lib/types";

export const dynamic = "force-dynamic";

const SUBMISSION_SELECT = `
  *,
  pronoun:pronouns(*),
  artist_genres(genres(*)),
  locations:artist_locations(*),
  label_list:artist_labels(*),
  links:artist_links(*)
`;

function normalizeArtist(row: any): ArtistWithRelations {
  const genres = (row.artist_genres ?? []).map((ag: any) => ag.genres).filter(Boolean);
  return { ...row, genres };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default async function AdminPage() {
  // ── Auth guard ────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");

  // ── Fetch pending artists, genres, and link categories ─────────
  const admin = getSupabaseAdminClient();
  const [
    { data: submissionRows, error },
    { data: genreRows },
    { data: platformRows },
  ] = await Promise.all([
    admin
      .from("artists")
      .select(SUBMISSION_SELECT)
      .eq("directory_status", "pending")
      .eq("deleted", false)
      .order("created_at", { ascending: true }),
    admin.from("genres").select("name").order("name"),
    admin.from("platforms").select("key, label").order("sort_order").order("label"),
  ]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 text-red-600">
        Error loading submissions: {error.message}
      </div>
    );
  }

  const submissions: ArtistWithRelations[] = (submissionRows ?? []).map(normalizeArtist);
  const genreNames = (genreRows ?? []).map((g: { name: string }) => g.name);
  const platforms = platformRows ?? [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin panel</h1>
        <Link
          href="/"
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          ← Directory
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        {/* ── LEFT COLUMN — system settings ─────────────────────── */}
        <div className="flex flex-col gap-6">
          <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="mb-3 text-lg font-semibold">Genres</h2>
            <AddGenreForm />
            {genreNames.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {genreNames.map((name) => (
                  <span
                    key={name}
                    className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="mb-3 text-lg font-semibold">Profile link categories</h2>
            <AddPlatformForm />
            {platforms.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {platforms.map((p) => (
                  <span
                    key={p.key}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  >
                    {p.label}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* More admin settings can be added as additional <section>
              blocks here. */}
        </div>

        {/* ── RIGHT COLUMN — pending submissions ────────────────── */}
        <div>
          <div className="mb-3">
            <h2 className="text-lg font-semibold">Pending submissions</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {submissions.length === 0
                ? "No pending submissions"
                : `${submissions.length} pending ${submissions.length === 1 ? "submission" : "submissions"}`}
            </p>
          </div>

          {submissions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center text-gray-500 dark:border-gray-700 dark:text-gray-400">
              All clear — nothing waiting for review.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {submissions.map((artist) => {
                const location = artist.locations?.[0];
                const locationStr = [location?.city, location?.country]
                  .filter(Boolean)
                  .join(", ");
                const genreStr = artist.genres?.map((g) => g.name).join(", ");
                const linkPlatforms = artist.links?.map((l) => l.platform).join(", ");
                const submittedAt =
                  (artist as any).submitted_at ?? artist.created_at;

                return (
                  <div
                    key={artist.id}
                    className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950"
                  >
                    <div className="flex flex-col gap-4">
                      {/* ── Artist info ───────────────────────── */}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <h3 className="text-lg font-semibold">{artist.name}</h3>
                          {artist.pronoun && (
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              {artist.pronoun.value}
                            </span>
                          )}
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            Submitted {formatDate(submittedAt)}
                          </span>
                        </div>

                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                          {locationStr && (
                            <>
                              <dt className="text-gray-500 dark:text-gray-400">Location</dt>
                              <dd>{locationStr}</dd>
                            </>
                          )}
                          {genreStr && (
                            <>
                              <dt className="text-gray-500 dark:text-gray-400">Genres</dt>
                              <dd>{genreStr}</dd>
                            </>
                          )}
                          {linkPlatforms && (
                            <>
                              <dt className="text-gray-500 dark:text-gray-400">Links</dt>
                              <dd>{linkPlatforms}</dd>
                            </>
                          )}
                          {artist.label_list?.length > 0 && (
                            <>
                              <dt className="text-gray-500 dark:text-gray-400">Labels</dt>
                              <dd>{artist.label_list.map((l) => l.name).join(", ")}</dd>
                            </>
                          )}
                          {(artist as any).notes && (
                            <>
                              <dt className="text-gray-500 dark:text-gray-400">Notes</dt>
                              <dd className="italic text-gray-600 dark:text-gray-400">
                                {(artist as any).notes}
                              </dd>
                            </>
                          )}
                          {(artist as any).submitted_by_email && (
                            <>
                              <dt className="text-gray-500 dark:text-gray-400">From</dt>
                              <dd className="text-gray-600 dark:text-gray-400">
                                {(artist as any).submitted_by_email}
                              </dd>
                            </>
                          )}
                        </dl>
                      </div>

                      {/* ── Actions ──────────────────────────── */}
                      <div className="flex gap-2">
                        <Link
                          href={`/artist/${artist.id}/edit?from=admin`}
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
                        >
                          Review &amp; edit
                        </Link>

                        <form
                          action={async () => {
                            "use server";
                            await quickApprove(artist.id);
                          }}
                        >
                          <button
                            type="submit"
                            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
                          >
                            Approve
                          </button>
                        </form>

                        <form
                          action={async () => {
                            "use server";
                            await quickReject(artist.id);
                          }}
                        >
                          <button
                            type="submit"
                            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
                          >
                            Reject
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
