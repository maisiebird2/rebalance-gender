"use client";

import { useEffect, useState } from "react";
import type { DiscoverResponse, DiscoverResult } from "@/app/api/discover/route";
import DiscoverResultsGrid from "@/components/DiscoverResultsGrid";

interface Props {
  searchTerm: string;
}

type State =
  | { status: "loading" }
  | { status: "done"; results: DiscoverResult[]; resolvedName: string }
  | { status: "error" };

export default function SearchMissResults({ searchTerm }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        // Fire both requests in parallel: save the miss + fetch discover results
        const [, discoverRes] = await Promise.all([
          fetch("/api/search-miss", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: searchTerm }),
          }),
          fetch("/api/discover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: searchTerm }),
          }),
        ]);

        if (cancelled) return;

        if (!discoverRes.ok) {
          setState({ status: "done", results: [], resolvedName: searchTerm });
          return;
        }

        const data = (await discoverRes.json()) as DiscoverResponse;
        if (!cancelled) {
          setState({
            status: "done",
            results: data.results,
            resolvedName: data.resolvedName,
          });
        }
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    }

    run();
    return () => { cancelled = true; };
  }, [searchTerm]);

  return (
    <div className="mt-2">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No artists named{" "}
        <span className="font-semibold text-gray-800 dark:text-gray-200">
          &ldquo;{searchTerm}&rdquo;
        </span>{" "}
        are in the directory yet — we&apos;ve noted them for review.
      </p>

      {state.status === "loading" && (
        <p className="mt-6 text-sm text-gray-400 dark:text-gray-500">
          Looking for similar artists…
        </p>
      )}

      {state.status === "error" && null}

      {state.status === "done" && state.results.length > 0 && (
        <div className="mt-6">
          <p className="mb-4 text-sm font-medium text-gray-600 dark:text-gray-400">
            You might also like these artists from the directory:
          </p>
          <DiscoverResultsGrid results={state.results} />
        </div>
      )}
    </div>
  );
}
