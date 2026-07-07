"use client";

import { useState, useTransition } from "react";
import { saveSiteContent } from "../actions";

export default function AboutEditForm({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const dirty = value !== initialValue;

  function handleSave() {
    setStatus("idle");
    setErrorMsg(null);
    startTransition(async () => {
      const result = await saveSiteContent("about", value);
      if ("error" in result) {
        setStatus("error");
        setErrorMsg(result.error);
      } else {
        setStatus("saved");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        This text is shown on the public{" "}
        <a href="/about" className="text-violet-600 hover:underline dark:text-violet-400">
          About page
        </a>
        . Leave a blank line between paragraphs.
      </p>

      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus("idle");
        }}
        rows={16}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:border-[#ff2d9b] focus:outline-none focus:ring-2 focus:ring-[#ff2d9b]/20 dark:border-white/10 dark:bg-white/5 dark:backdrop-blur"
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !dirty}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[linear-gradient(92deg,#7c5cff,#ff2d9b)] dark:hover:opacity-90"
        >
          {isPending ? "Saving…" : "Save changes"}
        </button>
        {status === "saved" && !dirty && (
          <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
        )}
        {status === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {errorMsg ?? "Something went wrong"}
          </span>
        )}
      </div>
    </div>
  );
}
