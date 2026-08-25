"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

interface FilterBarProps {
  genres: string[];
  countries: string[];
}

export default function FilterBar({ genres, countries }: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  // The URL is the source of truth, but router.push() runs inside a
  // transition, so searchParams only catches up once the server has
  // re-rendered. Mirroring it in local state keeps the checkbox responding
  // to the click straight away, and re-syncing when the URL changes from
  // elsewhere (Clear filters, back button) puts the two back in step. The
  // re-sync happens during render rather than in an effect — same pattern
  // as SearchMissResults — so it costs no extra render pass.
  const exactInUrl = searchParams.get("exact") === "1";
  const [trackedExact, setTrackedExact] = useState(exactInUrl);
  const [exact, setExact] = useState(exactInUrl);
  if (exactInUrl !== trackedExact) {
    setTrackedExact(exactInUrl);
    setExact(exactInUrl);
  }

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      // Any filter change resets back to page 1.
      params.delete("page");
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [router, pathname, searchParams, startTransition]
  );

  return (
    <div className="mb-6 flex flex-wrap gap-3">
      <input
        type="search"
        placeholder={exact ? "Exact name…" : "Search by name…"}
        defaultValue={searchParams.get("search") ?? ""}
        onChange={(e) => updateParam("search", e.target.value)}
        className="ff-mono w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#ff2d9b] focus:outline-none focus:ring-2 focus:ring-[#ff2d9b]/20 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur"
      />

      <label
        title="Match the whole name only — “Vel” finds Vel, not Velvet Underground"
        className="ff-mono flex cursor-pointer select-none items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:backdrop-blur"
      >
        <input
          type="checkbox"
          checked={exact}
          onChange={(e) => {
            setExact(e.target.checked);
            updateParam("exact", e.target.checked ? "1" : "");
          }}
          className="h-4 w-4 accent-[#ff2d9b]"
        />
        Exact match
      </label>

      <select
        defaultValue={searchParams.get("genre") ?? ""}
        onChange={(e) => updateParam("genre", e.target.value)}
        className="ff-mono rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#ff2d9b] focus:outline-none focus:ring-2 focus:ring-[#ff2d9b]/20 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur"
      >
        <option value="">All genres</option>
        {genres.map((genre) => (
          <option key={genre} value={genre}>
            {genre}
          </option>
        ))}
      </select>

      <select
        defaultValue={searchParams.get("country") ?? ""}
        onChange={(e) => updateParam("country", e.target.value)}
        className="ff-mono rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#ff2d9b] focus:outline-none focus:ring-2 focus:ring-[#ff2d9b]/20 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur"
      >
        <option value="">All countries</option>
        {countries.map((country) => (
          <option key={country} value={country}>
            {country}
          </option>
        ))}
      </select>

      {(searchParams.get("genre") ||
        searchParams.get("country") ||
        searchParams.get("search") ||
        exactInUrl) && (
        <button
          onClick={() => router.push(pathname)}
          className="ff-mono rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
