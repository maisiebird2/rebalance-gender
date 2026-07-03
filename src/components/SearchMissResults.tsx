"use client";

import { useEffect, useState } from "react";
import type { DiscoverResponse, DiscoverResult } from "@/app/api/discover/route";
import DiscoverResultsGrid from "@/components/DiscoverResultsGrid";

interface Props {
  searchTerm: string;
}

type DiscoverState =
  | { status: "loading" }
  | { status: "done"; results: DiscoverResult[] }
  | { status: "error" };

type SubmitState = "idle" | "submitting" | "submitted" | "exists" | "error";

export default function SearchMissResults({ searchTerm }: Props) {
  const [trackedTerm, setTrackedTerm] = useState(searchTerm);
  const [discover, setDiscover] = useState<DiscoverState>({ status: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>("idle");

  // Reset to "loading" as soon as the search term changes, during render
  // rather than in an effect — avoids an extra render pass.
  if (searchTerm !== trackedTerm) {
    setTrackedTerm(searchTerm);
    setDiscover({ status: "loading" });
    setSubmitState("idle");
  }

  // Fetching "similar artist" suggestions is read-only, so this can still run
  // automatically. Saving the searched name to the review queue is not — that
  // only happens if the visitor clicks the submit button below.
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const res = await fetch("/api/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: searchTerm }),
        });

        if (cancelled) return;

        if (!res.ok) {
          setDiscover({ status: "done", results: [] });
          return;
        }

        const data = (await res.json()) as DiscoverResponse;
        if (!cancelled) {
          setDiscover({ status: "done", results: data.results });
        }
      } catch {
        if (!cancelled) setDiscover({ status: "error" });
      }
    }

    run();
    return () => { cancelled = true; };
  }, [searchTerm]);

  async function handleSubmit() {
    setSubmitState("submitting");
    try {
      const res = await fetch("/api/search-miss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchTerm }),
      });

      if (!res.ok) {
        setSubmitState("error");
        return;
      }

      const data = await res.json();
      setSubmitState(data.alreadyExists ? "exists" : "submitted");
    } catch {
      setSubmitState("error");
    }
  }

  return (
    <div className="mt-2">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No artists named{" "}
        <span className="font-semibold text-gray-800 dark:text-gray-200">
          &ldquo;{searchTerm}&rdquo;
        </span>{" "}
        are in the directory yet.
      </p>

      <div className="mt-3">
        {submitState === "idle" && (
          <button
            onClick={handleSubmit}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
          >
            Submit &ldquo;{searchTerm}&rdquo; for review
          </button>
        )}

        {submitState === "submitting" && (
          <button
            disabled
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white opacity-50"
          >
            Submitting…
          </button>
        )}

        {submitState === "submitted" && (
          <p className="text-sm text-green-600 dark:text-green-400">
            Thanks — we&apos;ve added &ldquo;{searchTerm}&rdquo; to our review queue.
          </p>
        )}

        {submitState === "exists" && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            That name is already in our records and awaiting review.
          </p>
        )}

        {submitState === "error" && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Something went wrong submitting that — please try again.
          </p>
        )}
      </div>

      {discover.status === "loading" && (
        <p className="mt-6 text-sm text-gray-400 dark:text-gray-500">
          Looking for similar artists…
        </p>
      )}

      {discover.status === "done" && discover.results.length > 0 && (
        <div className="mt-6">
          <p className="mb-4 text-sm font-medium text-gray-600 dark:text-gray-400">
            You might also like these artists from the directory:
          </p>
          <DiscoverResultsGrid results={discover.results} />
        </div>
      )}
    </div>
  );
}
