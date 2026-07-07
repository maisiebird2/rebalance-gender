"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Header entry point for the "find similar artists" feature. A distinct
 * magenta pill (so it never reads as a twin of the name-search field) that
 * opens a small glass panel with a headline, a one-line explanation, an
 * input, and a hint. Submitting routes to /discover with the query
 * prefilled, where the results render.
 */
export default function DiscoverMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field when the panel opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setOpen(false);
    router.push(`/discover?q=${encodeURIComponent(q)}`);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-violet-300 bg-violet-50 px-3 text-sm font-medium text-violet-700 hover:bg-violet-100 dark:border-[#ff2d9b]/45 dark:bg-[#ff2d9b]/10 dark:text-[#ffb3d8] dark:hover:bg-[#ff2d9b]/20"
      >
        <span className="eq-mini" aria-hidden="true">
          <i></i>
          <i></i>
          <i></i>
        </span>
        Find similar
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Find similar artists"
          className="absolute right-0 top-[calc(100%+12px)] z-50 w-80 rounded-2xl border border-gray-200 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-[#12101b]/95 dark:shadow-2xl dark:backdrop-blur-xl"
        >
          <h2 className="ff-display text-[15px] font-semibold">
            Find artists similar to one you love
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            Enter an artist you love and we&rsquo;ll surface others in the
            directory with a similar sound.
          </p>
          <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. Objekt"
              className="ff-mono h-9 flex-1 rounded-lg border border-gray-300 px-3 text-sm focus:border-[#ff2d9b] focus:outline-none focus:ring-2 focus:ring-[#ff2d9b]/20 dark:border-white/10 dark:bg-white/5 dark:text-gray-100"
            />
            <button
              type="submit"
              className="h-9 shrink-0 rounded-lg bg-violet-600 px-3 text-sm font-medium text-white hover:bg-violet-700 dark:border-transparent dark:bg-[linear-gradient(92deg,#7c5cff,#ff2d9b)] dark:hover:opacity-90"
            >
              Find
            </button>
          </form>
          <p className="ff-mono mt-2 text-[11px] text-gray-400 dark:text-gray-500">
            Enter a name or a link (SoundCloud / Last.fm)
          </p>
        </div>
      )}
    </div>
  );
}
