import { NextResponse } from "next/server";
import { getViewer } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { buildOds, type Cell } from "@/lib/ods";
import { siteUrl } from "@/lib/site-url";

export const dynamic = "force-dynamic";

// Absolute origin used to build links to each artist's edit page.
const SITE_URL = siteUrl();

// PostgREST caps a single select at ~1000 rows, so page through with .range()
// to guarantee we export every failure regardless of table size.
const PAGE_SIZE = 1000;

interface FailureRow {
  url: string | null;
  status: string;
  detail: string | null;
  service: string;
  occurred_at: string;
  // Embedded via the harvest_failures.artist_id -> artists.id FK.
  artist: { id: string; name: string } | { id: string; name: string }[] | null;
}

/**
 * GET /api/admin/reports/harvest-failures
 *
 * Auth-guarded admin report. Streams a LibreOffice/OpenDocument spreadsheet
 * (.ods) of the harvest_failures table — the artist_id column is dropped and
 * replaced with the artist's name, hyperlinked to their edit page.
 */
export async function GET() {
  // ── Auth guard (admins only, same pattern as the rest of /admin) ─
  const { user, isAdmin } = await getViewer();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();

  const rows: FailureRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("harvest_failures")
      .select(
        "url, status, detail, service, occurred_at, artist:artists!harvest_failures_artist_id_fkey(id, name)",
      )
      .order("service", { ascending: true })
      .order("occurred_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error("harvest-failures report query:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const page = (data ?? []) as unknown as FailureRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const headers = [
    "Artist",
    "URL",
    "Status",
    "Detail",
    "Service",
    "Occurred at",
  ];

  const dataRows: Cell[][] = rows.map((row) => {
    const artist = Array.isArray(row.artist) ? row.artist[0] : row.artist;
    const artistCell: Cell = artist
      ? { text: artist.name, href: `${SITE_URL}/artist/${artist.id}/edit` }
      : "(unknown artist)";
    return [
      artistCell,
      row.url ?? "",
      row.status ?? "",
      row.detail ?? "",
      row.service ?? "",
      row.occurred_at ? { date: row.occurred_at } : "",
    ];
  });

  const ods = buildOds({
    name: "Harvest failures",
    headers,
    rows: dataRows,
  });

  const date = new Date().toISOString().slice(0, 10);
  const filename = `harvest-failures-${date}.ods`;

  return new NextResponse(new Uint8Array(ods), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.oasis.opendocument.spreadsheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(ods.length),
      "Cache-Control": "no-store",
    },
  });
}
