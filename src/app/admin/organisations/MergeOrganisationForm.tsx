"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Organisation } from "@/lib/types";
import { mergeOrganisations } from "./actions";

interface Props {
  organisation: Organisation;
  targets: { id: string; name: string; status: string }[];
}

/**
 * Fold this organisation into another. Two-step on purpose: the merge
 * moves rows and marks this one deleted, and picking the wrong target
 * from a long list is easy, so the chosen name is shown back before
 * anything happens.
 */
export default function MergeOrganisationForm({ organisation, targets }: Props) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [isMerging, startMerging] = useTransition();

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return targets.slice(0, 20);
    return targets.filter((t) => t.name.toLowerCase().includes(needle)).slice(0, 20);
  }, [targets, filter]);

  const target = targets.find((t) => t.id === targetId) ?? null;

  function handleMerge() {
    if (!target) return;
    setError(null);
    startMerging(async () => {
      const result = await mergeOrganisations(organisation.id, target.id);
      if ("error" in result) {
        setError(result.error);
      } else {
        setDone(`Moved ${result.moved} association${result.moved === 1 ? "" : "s"} to ${target.name}.`);
        router.refresh();
      }
    });
  }

  if (organisation.duplicate_of) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Already merged — nothing left to move.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Find the organisation to keep…"
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
      />

      <div className="max-h-48 overflow-y-auto rounded-md border border-gray-100 dark:border-gray-800">
        {matches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No matches.</p>
        ) : (
          matches.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTargetId(t.id)}
              className={
                targetId === t.id
                  ? "flex w-full items-center justify-between gap-2 border-b border-gray-100 bg-violet-50 px-3 py-1.5 text-left text-sm last:border-b-0 dark:border-gray-800 dark:bg-violet-950/40"
                  : "flex w-full items-center justify-between gap-2 border-b border-gray-100 px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
              }
            >
              <span className="truncate">{t.name}</span>
              <span className="shrink-0 text-xs text-gray-500">{t.status}</span>
            </button>
          ))
        )}
      </div>

      {target && (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Merging <strong>{organisation.name}</strong> into{" "}
          <strong>{target.name}</strong>.
        </p>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {done && <p className="text-sm text-green-600 dark:text-green-400">{done}</p>}

      <button
        type="button"
        onClick={handleMerge}
        disabled={!target || isMerging}
        className="self-start rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
      >
        {isMerging ? "Merging…" : "Merge"}
      </button>
    </div>
  );
}
