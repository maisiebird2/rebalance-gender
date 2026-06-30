"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import type { DiscoverResponse, DiscoverResult } from "@/app/api/discover/route";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "results"; resolvedName: string; results: DiscoverResult[] }
  | { status: "error"; message: string };

export default function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
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
        Enter an artist name or a Last.fm / SoundCloud URL to find similar
        artists in the directory.
      </p>

      {/* Search form */}
      <form onSubmit={handleSubmit} className="mt-6 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Objekt, or paste a Last.fm URL"
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
              <div className="grid grid-cols-3 gap-6 sm:grid-cols-4 md:grid-cols-5">
                {state.results.map((artist) => (
                  <Link
                    key={artist.id}
                    href={`/artist/${artist.id}`}
                    className="group flex flex-col items-center gap-2 text-center"
                  >
                    <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                      {artist.profile_image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={artist.profile_image_url}
                          alt={artist.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xl font-semibold text-gray-400">
                          {artist.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <span className="line-clamp-2 text-xs font-medium group-hover:underline">
                      {artist.name}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
