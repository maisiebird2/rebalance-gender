import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import {
  quickApprove,
  quickReject,
  quickMarkNotEligible,
  approveRevision,
  rejectRevision,
  blockEmail,
  unblockEmail,
} from "./actions";
import GenreModerationPanel from "./GenreModerationPanel";
import AddPlatformForm from "./AddPlatformForm";
import type { ArtistWithRelations, ArtistRevision, SubmitterEmail } from "@/lib/types";

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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");

  const admin = getSupabaseAdminClient();

  const [
    { data: submissionRows, error },
    { data: revisionRows },
    { data: genreRows },
    { data: platformRows },
    { data: emailRows },
  ] = await Promise.all([
    admin.from("artists").select(SUBMISSION_SELECT)
      .eq("directory_status", "pending").eq("deleted", false)
      .order("created_at", { ascending: true }),
    admin.from("artist_revisions").select(`
      *,
      artist:artists(id, name, directory_status)
    `).eq("status", "pending").order("created_at", { ascending: true }),
    admin.from("genres").select("id, name, status").order("name").limit(10000),
    admin.from("platforms").select("key, label").order("sort_order").order("label"),
    admin.from("submitter_emails").select("*")
      .order("first_seen_at", { ascending: false }).limit(100),
  ]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 text-red-600">
        Error loading submissions: {error.message}
      </div>
    );
  }

  const submissions: ArtistWithRelations[] = (submissionRows ?? []).map(normalizeArtist);
  const revisions = (revisionRows ?? []) as (ArtistRevision & { artist: { id: string; name: string } })[];
  const genres = (genreRows ?? []) as { id: number; name: string; status: "pending" | "approved" | "deleted" }[];
  const platforms = platformRows ?? [];
  const emails = (emailRows ?? []) as SubmitterEmail[];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin panel</h1>
        <Link href="/" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
          ← Directory
        </Link>
      </div>

      {/* ── TOP ROW: submissions + revisions ──────────────────── */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">

        {/* ── LEFT: Pending new submissions ─────────────────────── */}
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
            <EmptyState label="No pending submissions" />
          ) : (
            <div className="flex flex-col gap-4">
              {submissions.map((artist) => {
                const location = artist.locations?.[0];
                const locationStr = [location?.city, location?.country].filter(Boolean).join(", ");
                const genreStr = artist.genres?.map((g) => g.name).join(", ");
                const linkPlatforms = artist.links?.map((l) => l.platform).join(", ");
                const submittedAt = (artist as any).submitted_at ?? artist.created_at;

                return (
                  <div key={artist.id} className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
                    <div className="flex flex-col gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <h3 className="text-lg font-semibold">{artist.name}</h3>
                          {artist.pronoun && (
                            <span className="text-sm text-gray-500 dark:text-gray-400">{artist.pronoun.value}</span>
                          )}
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            Submitted {formatDate(submittedAt)}
                          </span>
                        </div>

                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                          {locationStr && (<><dt className="text-gray-500 dark:text-gray-400">Location</dt><dd>{locationStr}</dd></>)}
                          {genreStr && (<><dt className="text-gray-500 dark:text-gray-400">Genres</dt><dd>{genreStr}</dd></>)}
                          {linkPlatforms && (<><dt className="text-gray-500 dark:text-gray-400">Links</dt><dd>{linkPlatforms}</dd></>)}
                          {artist.label_list?.length > 0 && (
                            <><dt className="text-gray-500 dark:text-gray-400">Labels</dt><dd>{artist.label_list.map((l) => l.name).join(", ")}</dd></>
                          )}
                          {(artist as any).notes && (
                            <><dt className="text-gray-500 dark:text-gray-400">Notes</dt><dd className="italic text-gray-600 dark:text-gray-400">{(artist as any).notes}</dd></>
                          )}
                          {(artist as any).submitted_by_email && (
                            <><dt className="text-gray-500 dark:text-gray-400">From</dt><dd className="text-gray-600 dark:text-gray-400">{(artist as any).submitted_by_email}</dd></>
                          )}
                        </dl>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Link href={`/artist/${artist.id}/edit?from=admin`}
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
                          Review &amp; edit
                        </Link>
                        <form action={async () => { "use server"; await quickApprove(artist.id); }}>
                          <button type="submit" className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700">
                            Approve
                          </button>
                        </form>
                        <form action={async () => { "use server"; await quickReject(artist.id); }}>
                          <button type="submit" className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950">
                            Reject
                          </button>
                        </form>
                        <form action={async () => { "use server"; await quickMarkNotEligible(artist.id); }}>
                          <button type="submit" className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950">
                            Not eligible
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

        {/* ── RIGHT: Pending revisions ──────────────────────────── */}
        <div>
          <div className="mb-3">
            <h2 className="text-lg font-semibold">Pending revisions</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {revisions.length === 0
                ? "No pending revisions"
                : `${revisions.length} pending ${revisions.length === 1 ? "revision" : "revisions"}`}
            </p>
          </div>

          {revisions.length === 0 ? (
            <EmptyState label="No pending revisions" />
          ) : (
            <div className="flex flex-col gap-4">
              {revisions.map((rev) => {
                const rd = rev.revision_data;
                return (
                  <div key={rev.id} className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
                    <div className="flex flex-col gap-3">
                      <div>
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <Link href={`/artist/${rev.artist.id}`}
                            className="text-base font-semibold text-violet-700 hover:underline dark:text-violet-400">
                            {rev.artist.name}
                          </Link>
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {formatDate(rev.created_at)}
                          </span>
                        </div>
                        {rev.submitted_by_email && (
                          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                            From: {rev.submitted_by_email}
                          </p>
                        )}
                      </div>

                      {/* Show proposed changes */}
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        {rd.name && (<><dt className="text-gray-500">Name</dt><dd>{rd.name}</dd></>)}
                        {rd.pronouns && (<><dt className="text-gray-500">Pronouns</dt><dd>{rd.pronouns}</dd></>)}
                        {rd.genres?.length && (
                          <><dt className="text-gray-500">Genres</dt><dd>{rd.genres.join(", ")}</dd></>
                        )}
                        {rd.locations?.length && (
                          <><dt className="text-gray-500">Locations</dt>
                          <dd>{rd.locations.map((l) => [l.city, l.country].filter(Boolean).join(", ")).join(" | ")}</dd></>
                        )}
                        {rd.labels?.length && (<><dt className="text-gray-500">Labels</dt><dd>{rd.labels.join(", ")}</dd></>)}
                        {rd.links && Object.keys(rd.links).length > 0 && (
                          <><dt className="text-gray-500">Links</dt>
                          <dd className="break-all">{Object.entries(rd.links).map(([k, v]) => `${k}: ${v}`).join("; ")}</dd></>
                        )}
                        {rev.submitter_notes && (
                          <><dt className="text-gray-500">Notes</dt>
                          <dd className="italic text-gray-600 dark:text-gray-400">{rev.submitter_notes}</dd></>
                        )}
                      </dl>

                      <div className="flex flex-wrap gap-2">
                        <Link href={`/artist/${rev.artist.id}/edit?from=admin`}
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
                          Review artist
                        </Link>
                        <form action={async () => { "use server"; await approveRevision(rev.id); }}>
                          <button type="submit" className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700">
                            Apply &amp; approve
                          </button>
                        </form>
                        <form action={async () => { "use server"; await rejectRevision(rev.id); }}>
                          <button type="submit" className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950">
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

      {/* ── BOTTOM ROW: settings + email management ────────────── */}
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">

        {/* ── Settings ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-6">
          <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="mb-3 text-lg font-semibold">Genres</h2>
            <GenreModerationPanel genres={genres} />
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="mb-3 text-lg font-semibold">Profile link categories</h2>
            <AddPlatformForm />
            {platforms.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {platforms.map((p) => (
                  <span key={p.key}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    {p.label}
                  </span>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ── Email management ───────────────────────────────────── */}
        <div>
          <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="mb-3 text-lg font-semibold">Submitter emails</h2>
            {emails.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No emails on record yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {emails.map((e) => (
                  <div key={e.email}
                    className="flex items-center justify-between gap-3 rounded-md border border-gray-100 px-3 py-2 text-sm dark:border-gray-800">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">{e.email}</p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        <StatusBadge status={e.status} />
                        {" · "}{e.submission_count} submission{e.submission_count !== 1 ? "s" : ""}
                      </p>
                      {e.block_reason && (
                        <p className="text-xs text-red-500 dark:text-red-400">{e.block_reason}</p>
                      )}
                    </div>
                    <div className="shrink-0">
                      {e.status === "blocked" ? (
                        <form action={async () => { "use server"; await unblockEmail(e.email); }}>
                          <button type="submit"
                            className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
                            Unblock
                          </button>
                        </form>
                      ) : (
                        <form action={async () => { "use server"; await blockEmail(e.email); }}>
                          <button type="submit"
                            className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950">
                            Block
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
      {label}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colours: Record<string, string> = {
    verified: "text-green-600 dark:text-green-400",
    unverified: "text-amber-600 dark:text-amber-400",
    blocked: "text-red-600 dark:text-red-400",
  };
  return (
    <span className={colours[status] ?? "text-gray-500"}>
      {status}
    </span>
  );
}
