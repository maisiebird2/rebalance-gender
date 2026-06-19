"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useTransition } from "react";

interface FilterBarProps {
  genres: string[];
  countries: string[];
}

export default function FilterBar({ genres, countries }: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

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
        placeholder="Search by name…"
        defaultValue={searchParams.get("search") ?? ""}
        onChange={(e) => updateParam("search", e.target.value)}
        className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
      />

      <select
        defaultValue={searchParams.get("genre") ?? ""}
        onChange={(e) => updateParam("genre", e.target.value)}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
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
        className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
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
        searchParams.get("search")) && (
        <button
          onClick={() => router.push(pathname)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
