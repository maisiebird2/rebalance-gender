"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { DiscoverResponse, DiscoverResult } from "@/app/api/discover/route";
import DiscoverResultsGrid from "@/components/DiscoverResultsGrid";
import { randomSampleArtist } from "@/lib/sample-artists";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "results"; resolvedName: string; results: DiscoverResult[] }
  | { status: "error"; message: string };

export default function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  // Set a random sample name as the input's placeholder on each page load.
  // Written straight to the DOM (not React state) so it stays client-only
  // and doesn't affect server/client hydration.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.placeholder = `e.g. ${randomSampleArtist()}`;
    }
  }, []);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) return;

    setState({ status: "loading" });

    try {
      const r = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = await r.json();

      if (!r.ok) {
        setState({ status: "error", message: data.error ?? "Something went wrong" });
        return;
      }

      const { resolvedName, results } = data as DiscoverResponse;
      setState({ status: "results", resolvedName, results });
    } catch {
      setState({ status: "error", message: "Network error — please try again" });
    }
  }, []);

  // If arriving from the header's "Discover similar" panel (/discover?q=…),
  // prefill the field and run the search automatically. The value comes from
  // the URL, which is client-only, so it can't be initial state without a
  // hydration mismatch — hence setState in this mount effect.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q")?.trim();
    if (q) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery(q);
      runSearch(q);
    }
  }, [runSearch]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch(query);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <Link
        href="/"
        className="text-sm text-violet-600 hover:underline dark:text-violet-400"
      >
        ← Back to directory
      </Link>

      <h1 className="mt-6 text-2xl font-bold">Discover artists</h1>
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
        Enter a name or a link (SoundCloud / Last.fm) to find similar artists
        in the directory.
      </p>

      {/* Search form */}
      <form onSubmit={handleSubmit} className="mt-6 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm shadow-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <button
          type="submit"
          disabled={state.status === "loading" || !query.trim()}
          className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {state.status === "loading" ? "Searching…" : "Search"}
        </button>
      </form>

      {/* Results */}
      <div className="mt-8">
        {state.status === "loading" && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Looking up similar artists…
          </p>
        )}

        {state.status === "error" && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {state.message}
          </p>
        )}

        {state.status === "results" && (
          <>
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              Artists in the directory similar to{" "}
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {state.resolvedName}
              </span>
              :
            </p>

            {state.results.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No matches found in the directory. Try a different artist.
              </p>
            ) : (
              <DiscoverResultsGrid results={state.results} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
