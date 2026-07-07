"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";

export default function HeaderSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = inputRef.current?.value.trim() ?? "";
    if (value) {
      router.push(`/?search=${encodeURIComponent(value)}`);
    } else {
      router.push("/");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center">
      <input
        ref={inputRef}
        type="search"
        placeholder="Search artists…"
        className="ff-mono w-40 rounded-l-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#ff2d9b] dark:border-white/10 dark:bg-white/5 dark:text-gray-100 dark:backdrop-blur sm:w-56"
      />
      <button
        type="submit"
        className="rounded-r-lg border border-l-0 border-gray-300 bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-700 focus:outline-none focus:ring-1 focus:ring-[#ff2d9b] dark:border-transparent dark:bg-[linear-gradient(92deg,#7c5cff,#ff2d9b)] dark:hover:opacity-90"
      >
        Search
      </button>
    </form>
  );
}
