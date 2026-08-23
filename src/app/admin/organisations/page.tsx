import { redirect } from "next/navigation";
import Link from "next/link";
import { getViewer } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase";
import NotAdminNotice from "@/components/NotAdminNotice";
import OrganisationsPanel, { type OrganisationRow } from "./OrganisationsPanel";

export const dynamic = "force-dynamic";

// PostgREST caps a single select at ~1000 rows regardless of .limit(), so
// every read here pages with .range() — the backfill creates ~208
// organisations on day one and that ceiling is not far off.
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  table: string,
  select: string,
  orderBy: string,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from(table)
      .select(select)
      .order(orderBy)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      // Migration not run yet — render the page empty rather than 500ing.
      if (error.code === "42P01") return [];
      throw error;
    }
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

export default async function AdminOrganisationsPage() {
  const { user, isAdmin } = await getViewer();
  if (!user) redirect("/login?next=/admin/organisations");
  if (!isAdmin) return <NotAdminNotice />;

  const admin = getSupabaseAdminClient();

  const [organisations, associations, typeLinks, types] = await Promise.all([
    fetchAllRows<{
      id: string;
      name: string;
      status: OrganisationRow["status"];
      duplicate_of: string | null;
    }>(admin, "organisations", "id, name, status, duplicate_of", "name"),
    fetchAllRows<{ organisation_id: string; artist_id: string }>(
      admin,
      "artist_organisations",
      "organisation_id, artist_id",
      "organisation_id",
    ),
    fetchAllRows<{ organisation_id: string; type_key: string }>(
      admin,
      "organisation_type_links",
      "organisation_id, type_key",
      "organisation_id",
    ),
    fetchAllRows<{ key: string; label: string }>(
      admin,
      "organisation_types",
      "key, label",
      "sort_order",
    ),
  ]);

  // An artist can hold several roles at one organisation (three rows for
  // one person), so count distinct artists rather than rows — otherwise
  // the list overstates how many people are attached.
  const artistsByOrg = new Map<string, Set<string>>();
  for (const row of associations) {
    if (!artistsByOrg.has(row.organisation_id)) artistsByOrg.set(row.organisation_id, new Set());
    artistsByOrg.get(row.organisation_id)!.add(row.artist_id);
  }

  const typeLabel = new Map(types.map((t) => [t.key, t.label]));
  const typesByOrg = new Map<string, string[]>();
  for (const row of typeLinks) {
    if (!typesByOrg.has(row.organisation_id)) typesByOrg.set(row.organisation_id, []);
    typesByOrg.get(row.organisation_id)!.push(typeLabel.get(row.type_key) ?? row.type_key);
  }

  const rows: OrganisationRow[] = organisations.map((org) => ({
    ...org,
    artist_count: artistsByOrg.get(org.id)?.size ?? 0,
    types: typesByOrg.get(org.id) ?? [],
  }));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Organisations</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/settings"
            className="text-sm text-violet-600 hover:underline dark:text-violet-400"
          >
            Roles &amp; types →
          </Link>
          <Link
            href="/admin"
            className="text-sm text-violet-600 hover:underline dark:text-violet-400"
          >
            ← Back to admin panel
          </Link>
        </div>
      </div>

      <p className="mb-6 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
        Record labels, clubs, crews and events as real entries. The backfill
        creates every migrated organisation as <strong>pending</strong>, so
        nothing reaches the public site until it has been seen here — that is
        what catches the near-duplicates and the rows that were never an
        organisation at all. Types, locations and links are filled in by hand
        on each organisation&apos;s page.
      </p>

      <OrganisationsPanel organisations={rows} />
    </div>
  );
}
