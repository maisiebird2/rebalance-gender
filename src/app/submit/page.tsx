// "Submit an artist" page
// src/app/submit/page.tsx

import SubmissionForm from "@/components/SubmissionForm";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getViewer } from "@/lib/admin-auth";
import { getPlatforms } from "@/lib/platforms";
import { getGenrePickerOptions, getOrganisationPickerOptions } from "@/lib/queries"

export const metadata = {
  title: "Submit an artist",
};

export default async function SubmitPage() {
  const admin = getSupabaseAdminClient();
  // Only admins get the trusted form (no Turnstile/email, internal notes);
  // /api/submit treats non-admin sessions exactly like anonymous visitors,
  // so the form has to match or their submissions would be rejected.
  const [genreOptions, organisationOptions, platforms, { isAdmin }] = await Promise.all([
    getGenrePickerOptions(),
    getOrganisationPickerOptions(),
    getPlatforms(admin),
    getViewer(),
  ]);

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-2 text-2xl font-bold">Submit an artist</h1>
      <p className="mb-6 text-gray-600 dark:text-gray-400">
        Know someone who should be on this list? Submissions are reviewed
        before they appear publicly.
      </p>
      <SubmissionForm
        genreOptions={genreOptions}
        organisationOptions={organisationOptions}
        platforms={platforms}
        isAdmin={isAdmin}
      />
    </div>
  );
}
