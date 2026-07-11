"use client";

import { useState } from "react";
import type { ReportDefinition } from "@/lib/reports";

/**
 * One report card with a "Download .ods" button. Fetches the report endpoint,
 * shows a generating/​error state, and saves the returned spreadsheet via a
 * temporary object-URL anchor (so the browser downloads it instead of
 * navigating away).
 */
export default function ReportButton({ report }: { report: ReportDefinition }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleDownload() {
    setState("loading");
    setMessage(null);
    try {
      const res = await fetch(report.endpoint);
      if (!res.ok) {
        let detail = `Request failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch {
          /* non-JSON error body — keep the status message */
        }
        throw new Error(detail);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `${report.slug}.ods`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setState("idle");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Download failed");
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">{report.title}</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {report.description}
          </p>
          {state === "error" && message && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">
              {message}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={state === "loading"}
          className="shrink-0 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === "loading" ? "Generating…" : "Download .ods"}
        </button>
      </div>
    </div>
  );
}
