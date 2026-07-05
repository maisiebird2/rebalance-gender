import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { blockEmail, unblockEmail } from "../actions";
import GenreModerationPanel from "../GenreModerationPanel";
import AddPlatformForm from "../AddPlatformForm";
import type { SubmitterEmail } from "@/lib/types";

export const dynamic = "force-dynamic";

type GenreRow = { id: number; name: string; status: "pending" | "approved" | "deleted" };

// PostgREST caps a single select at ~1000 rows (the API "Max rows" setting),
// so a plain .limit(10000) still returns only the first 1000 genres by name —
// which is why the panel used to stop around "rnb". Page through with .range()
// to load the full list regardless of how many genres exist.
async function fetchAllGenres(
  admin: ReturnType<typeof getSupabaseAdminClient>,
): Promise<GenreRow[]> {
  const PAGE_SIZE = 1000;
  const all: GenreRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("genres")
      .select("id, name, status")
      .order("name")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as GenreRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

export default async function AdminSettingsPage() {
  // ── Auth guard ────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/settings");

  const admin = getSupabaseAdminClient();

  const [
    genres,
    { data: platformRows },
    { data: emailRows },
  ] = await Promise.all([
    fetchAllGenres(admin),
    admin.from("platforms").select("key, label").order("sort_order").order("label"),
    admin.from("submitter_emails").select("*")
      .order("first_seen_at", { ascending: false }).limit(100),
  ]);

  const platforms = platformRows ?? [];
  const emails = (emailRows ?? []) as SubmitterEmail[];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Genres, links &amp; emails</h1>
        <Link href="/admin" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
          ← Back to admin panel
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
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
