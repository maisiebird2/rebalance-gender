"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";

interface PlatformOption {
  key: string;
  label: string;
}

/** Dropdown that puts the chosen platform in the URL (?platform=...). */
export default function PlatformSelect({
  platforms,
}: {
  platforms: PlatformOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  return (
    <select
      defaultValue={searchParams.get("platform") ?? ""}
      onChange={(e) => {
        const params = new URLSearchParams();
        if (e.target.value) params.set("platform", e.target.value);
        startTransition(() => {
          router.push(
            params.size ? `${pathname}?${params.toString()}` : pathname
          );
        });
      }}
      className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <option value="">Choose a platform…</option>
      {platforms.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
