"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  // Default assumption matches the server-rendered class (dark); the
  // effect below reconciles with whatever localStorage/the inline
  // bootstrap script actually set before paint.
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  const applyTheme = (next: Theme) => {
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    window.localStorage.setItem("theme", next);
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
