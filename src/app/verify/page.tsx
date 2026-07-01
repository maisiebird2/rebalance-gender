import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";

interface PageProps {
  searchParams: Promise<Record<string, string>>;
}

function VerifyContent({ params }: { params: Record<string, string> }) {
  const token = params.token;
  const success = params.success;
  const error = params.error;
  const type = params.type as "artist" | "revision" | undefined;

  // If a raw token is in the URL (user landed here directly rather than via
  // the API route), redirect them to the API handler.
  if (token && !success && !error) {
    redirect(`/api/verify?token=${encodeURIComponent(token)}`);
  }

  if (success) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-6 text-center dark:border-green-900 dark:bg-green-950">
        <p className="text-lg font-semibold text-green-800 dark:text-green-200">
          {type === "revision" ? "Revision confirmed!" : "Submission confirmed!"}
        </p>
        <p className="mt-2 text-sm text-green-700 dark:text-green-300">
          {type === "revision"
            ? "Your suggested changes have been sent to our review queue."
            : "Your artist submission has been sent to our review queue. We'll review it shortly."}
        </p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700"
        >
          Back to directory
        </Link>
      </div>
    );
  }

  const errorMessages: Record<string, string> = {
    missing: "No verification token was provided.",
    invalid: "This verification link is invalid or doesn't exist.",
    used: "This verification link has already been used.",
    expired: "This verification link has expired (links are valid for 48 hours).",
    server: "Something went wrong on our end. Please try submitting again.",
  };

  const message = error ? (errorMessages[error] ?? "Something went wrong.") : "Something went wrong.";

  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950">
      <p className="text-lg font-semibold text-red-800 dark:text-red-200">Verification failed</p>
      <p className="mt-2 text-sm text-red-700 dark:text-red-300">{message}</p>
      <div className="mt-4 flex justify-center gap-3">
        <Link href="/submit"
          className="rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700">
          Submit again
        </Link>
        <Link href="/"
          className="rounded-md border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900">
          Back to directory
        </Link>
      </div>
    </div>
  );
}

export default async function VerifyPage({ searchParams }: PageProps) {
  const params = await searchParams;

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Suspense>
        <VerifyContent params={params} />
      </Suspense>
    </div>
  );
}
