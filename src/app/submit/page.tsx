// "Submit an artist" page
// src/app/submit/page.tsx

import SubmissionForm from "@/components/SubmissionForm";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { getPlatforms } from "@/lib/platforms";
import { getGenreOptions } from "@/lib/queries"

export const metadata = {
  title: "Submit an artist — Rebalance Gender",
};

export default async function SubmitPage() {
  const admin = getSupabaseAdminClient();
  const supabase = await createClient();
  const [genreOptions, platforms, { data: { user } }] = await Promise.all([
    getGenreOptions(),
    getPlatforms(admin),
    supabase.auth.getUser(),
  ]);

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-2 text-2xl font-bold">Submit an artist</h1>
      <p className="mb-6 text-gray-600 dark:text-gray-400">
        Know someone who should be on this list? Submissions are reviewed
        before they appear publicly.
      </p>
      <SubmissionForm genreOptions={genreOptions} platforms={platforms} isLoggedIn={!!user} />
    </div>
  );
}
