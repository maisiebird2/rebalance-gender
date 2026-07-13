import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { REPORTS } from "@/lib/reports";
import ReportButton from "./ReportButton";

export const dynamic = "force-dynamic";

export default async function AdminReportsPage() {
  // ── Auth guard (same as the rest of /admin) ───────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/reports");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Reports</h1>
        <Link
          href="/admin"
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          ← Admin panel
        </Link>
      </div>

      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Each report either downloads a LibreOffice spreadsheet (.ods) or copies
        a SQL query to paste into the Supabase SQL editor — see its description.
      </p>

      <div className="space-y-4">
        {REPORTS.map((report) => (
          <ReportButton key={report.slug} report={report} />
        ))}
      </div>
    </div>
  );
}
