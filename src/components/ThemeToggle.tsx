"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

// The <html> element's class list (set by the inline bootstrap script
// before paint, and by applyTheme below) is the actual source of truth
// for the theme — treat it as an external system via useSyncExternalStore
// rather than shadowing it in local state.
const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Server-rendered <html> always has the `dark` class (see layout.tsx).
function getServerSnapshot(): Theme {
  return "dark";
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const applyTheme = (next: Theme) => {
    document.documentElement.classList.toggle("dark", next === "dark");
    window.localStorage.setItem("theme", next);
    listeners.forEach((l) => l());
  };

  return (
    <div className="flex items-center overflow-hidden rounded-md border border-gray-300 text-xs dark:border-gray-700">
      <button
        type="button"
        onClick={() => applyTheme("light")}
        aria-pressed={theme === "light"}
        className={`px-2.5 py-1 ${
          theme === "light"
            ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
            : "text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
        }`}
      >
        Light mode
      </button>
      <button
        type="button"
        onClick={() => applyTheme("dark")}
        aria-pressed={theme === "dark"}
        className={`border-l border-gray-300 px-2.5 py-1 dark:border-gray-700 ${
          theme === "dark"
            ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
            : "text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
        }`}
      >
        Dark mode
      </button>
    </div>
  );
}
