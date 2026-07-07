import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import AboutEditForm from "./AboutEditForm";

export const dynamic = "force-dynamic";

export default async function AdminAboutPage() {
  // ── Auth guard ────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/about");

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
