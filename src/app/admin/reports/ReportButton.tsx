"use client";

import { useState } from "react";
import type { ReportDefinition } from "@/lib/reports";

/**
 * One report card. Either a "Download .ods" button (kind: "download") that
 * fetches the report endpoint and saves the returned spreadsheet, or a
 * "Copy SQL" button (kind: "sql") that copies the query to the clipboard for
 * pasting into the Supabase SQL editor.
 */
export default function ReportButton({ report }: { report: ReportDefinition }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <h3 className="font-semibold">{report.title}</h3>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {report.description}
      </p>
      <ReportAction report={report} />
    </div>
  );
}

function ReportAction({ report }: { report: ReportDefinition }) {
  if (report.kind === "sql") return <CopySqlButton sql={report.sql} />;
  return <DownloadButton endpoint={report.endpoint} slug={report.slug} />;
}

const buttonClass =
  "mt-3 shrink-0 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60";

function CopySqlButton({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCopy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the query manually.");
    }
  }

  return (
    <div>
      <button type="button" onClick={handleCopy} className={buttonClass}>
        {copied ? "Copied!" : "Copy SQL"}
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function DownloadButton({
  endpoint,
  slug,
}: {
  endpoint: string;
  slug: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleDownload() {
    setState("loading");
    setMessage(null);
    try {
      const res = await fetch(endpoint);
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
      const filename = match?.[1] ?? `${slug}.ods`;

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
    <div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={state === "loading"}
        className={buttonClass}
      >
        {state === "loading" ? "Generating…" : "Download .ods"}
      </button>
      {state === "error" && message && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{message}</p>
      )}
    </div>
  );
}
