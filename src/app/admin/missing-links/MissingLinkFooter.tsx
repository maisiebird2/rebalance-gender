"use client";

import { useEffect, useState, useTransition } from "react";
import {
  saveArtistPlatformLink,
  markArtistLinkNotFound,
} from "./actions";
import type { LinkCandidate } from "@/lib/search-providers";

interface MissingLinkFooterProps {
  artistId: string;
  artistName: string;
  platformKey: string;
  platformLabel: string;
  /** Prebuilt "search on <platform>" URL (from search_url_template). */
  searchUrl: string | null;
  /** Whether the server can fetch inline candidates for this platform. */
  hasProvider: boolean;
  /**
   * Delay before this card fetches its candidates. Cards are staggered
   * by the page so a grid of them doesn't hammer rate-limited APIs
   * (MusicBrainz allows 1 req/s).
   */
  fetchDelayMs: number;
}

type FetchState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; candidates: LinkCandidate[] }
  | { status: "error"; message: string };

type SavedState =
  | null
  | { kind: "link"; url: string }
  | { kind: "not_found" };

export default function MissingLinkFooter({
  artistId,
  artistName,
  platformKey,
  platformLabel,
  searchUrl,
  hasProvider,
  fetchDelayMs,
}: MissingLinkFooterProps) {
  const [fetchState, setFetchState] = useState<FetchState>({
    status: hasProvider ? "loading" : "idle",
  });
  const [saved, setSaved] = useState<SavedState>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [confirmingNotFound, setConfirmingNotFound] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!hasProvider) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          platform: platformKey,
          name: artistName,
        });
        const res = await fetch(`/api/admin/platform-search?${params}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setFetchState({ status: "loaded", candidates: data.candidates ?? [] });
      } catch (err) {
        if (controller.signal.aborted) return;
        setFetchState({
          status: "error",
          message: err instanceof Error ? err.message : "Search failed",
        });
      }
    }, fetchDelayMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [hasProvider, platformKey, artistName, fetchDelayMs]);

  function save(url: string) {
    setSaveError(null);
    setPendingUrl(url);
    startTransition(async () => {
      const result = await saveArtistPlatformLink(artistId, platformKey, url);
      setPendingUrl(null);
      if (result.error) setSaveError(result.error);
      else setSaved({ kind: "link", url });
    });
  }

  function notFound() {
    setConfirmingNotFound(false);
    setSaveError(null);
    startTransition(async () => {
      const result = await markArtistLinkNotFound(artistId, platformKey);
      if (result.error) setSaveError(result.error);
      else setSaved({ kind: "not_found" });
    });
  }

  // ── Saved: collapse to a confirmation ─────────────────────────
  if (saved) {
    return (
      <p className="text-sm text-green-700 dark:text-green-400">
        {saved.kind === "link" ? (
          <>
            Saved ✓{" "}
            <a
              href={saved.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {saved.url}
            </a>
          </>
        ) : (
          <>Marked as not on {platformLabel} ✓</>
        )}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      {/* Inline candidates (platforms with a search provider) */}
      {fetchState.status === "loading" && (
        <p className="text-gray-400">Looking for matches…</p>
      )}
      {fetchState.status === "error" && (
        <p className="text-amber-600 dark:text-amber-400">
          Couldn&apos;t fetch matches: {fetchState.message}
        </p>
      )}
      {fetchState.status === "loaded" &&
        (fetchState.candidates.length === 0 ? (
          <p className="text-gray-400">No matches found.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {fetchState.candidates.map((c) => (
              <li key={c.url} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={pendingUrl === c.url}
                  disabled={isPending}
                  onChange={() => save(c.url)}
                  aria-label={`Use ${c.url} for ${artistName}`}
                  className="mt-1 h-4 w-4 shrink-0 accent-violet-600"
                />
                <span className="min-w-0">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-violet-700 hover:underline dark:text-violet-300"
                  >
                    {c.name}
                  </a>
                  {c.detail && (
                    <span className="text-gray-500 dark:text-gray-400">
                      {" "}
                      · {c.detail}
                    </span>
                  )}
                  <span className="block truncate text-xs text-gray-400">
                    {c.url}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ))}

      {saveError && (
        <p className="text-red-600 dark:text-red-400">{saveError}</p>
      )}

      {/* Manual entry, for when none of the suggestions is right */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (manualUrl.trim()) save(manualUrl.trim());
        }}
        className="flex gap-2"
      >
        <input
          type="url"
          value={manualUrl}
          onChange={(e) => setManualUrl(e.target.value)}
          placeholder={`Paste ${platformLabel} URL…`}
          disabled={isPending}
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <button
          type="submit"
          disabled={isPending || !manualUrl.trim()}
          className="shrink-0 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          Save
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {searchUrl && (
          <a
            href={searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-600 hover:underline dark:text-violet-400"
          >
            {platformLabel} search for {artistName}
          </a>
        )}
        <button
          onClick={() => setConfirmingNotFound(true)}
          disabled={isPending}
          className="text-gray-500 hover:text-gray-700 hover:underline disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-200"
        >
          Not on {platformLabel}
        </button>
      </div>

      {/* Confirmation modal for "Not on {platform}" */}
      {confirmingNotFound && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmingNotFound(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm marking ${artistName} as not on ${platformLabel}`}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-5 shadow-lg dark:border-gray-700 dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-4">
              Mark <span className="font-semibold">{artistName}</span> as not
              on {platformLabel}? They&apos;ll stop appearing in this list for{" "}
              {platformLabel}.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmingNotFound(false)}
                autoFocus
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={notFound}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
              >
                Not on {platformLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
