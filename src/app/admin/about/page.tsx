import { redirect } from "next/navigation";
import Link from "next/link";
import { getViewer } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/lib/supabase";
import NotAdminNotice from "@/components/NotAdminNotice";
import AboutEditForm from "./AboutEditForm";

export const dynamic = "force-dynamic";

export default async function AdminAboutPage() {
  // ── Auth guard (admins only) ──────────────────────────────────
  const { user, isAdmin } = await getViewer();
  if (!user) redirect("/login?next=/admin/about");
  if (!isAdmin) return <NotAdminNotice />;

  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("site_content")
    .select("value")
    .eq("key", "about")
    .maybeSingle();

  const initialValue = data?.value ?? "";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Edit About page</h1>
        <Link href="/admin" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
          ← Back to admin panel
        </Link>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
        <AboutEditForm initialValue={initialValue} />
      </section>
    </div>
  );
}
