import SubmissionForm from "@/components/SubmissionForm";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getPlatforms } from "@/lib/platforms";

export const metadata = {
  title: "Submit an artist — Women in Electronic Music",
};

export default async function SubmitPage() {
  const admin = getSupabaseAdminClient();
  const [{ data: genreRows }, platforms] = await Promise.all([
    admin.from("genres").select("name").order("name"),
    getPlatforms(admin),
  ]);
  const allGenres = (genreRows ?? []).map((g: { name: string }) => g.name);

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-2 text-2xl font-bold">Submit an artist</h1>
      <p className="mb-6 text-gray-600 dark:text-gray-400">
        Know someone who should be on this list? Submissions are reviewed
        before they appear publicly.
      </p>
      <SubmissionForm allGenres={allGenres} platforms={platforms} />
    </div>
  );
}
