"use client";

import { useTransition, useState } from "react";
import { approveGenre, deleteGenre, restoreGenre } from "./actions";
import AddGenreForm from "./AddGenreForm";

interface Genre {
  id: number;
  name: string;
  status: "pending" | "approved" | "deleted";
}

interface Props {
  genres: Genre[];
}

export default function GenreModerationPanel({ genres }: Props) {
  const [, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  const pending = genres.filter((g) => g.status === "pending");
  const approved = genres.filter((g) => g.status === "approved");
  const deleted = genres.filter((g) => g.status === "deleted");

  function handleApprove(id: number) {
    setPendingId(id);
    startTransition(async () => {
      await approveGenre(id);
      setPendingId(null);
    });
  }

  function handleDelete(id: number) {
    setPendingId(id);
    startTransition(async () => {
      await deleteGenre(id);
      setPendingId(null);
    });
  }

  function handleRestore(id: number) {
    setPendingId(id);
    startTransition(async () => {
      await restoreGenre(id);
      setPendingId(null);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── Add genre ───────────────────────────────────────────── */}
      <AddGenreForm />

      {/* ── Pending ─────────────────────────────────────────────── */}
      {pending.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            {pending.length} pending review
          </p>
          <div className="flex flex-col gap-1.5">
            {pending.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 dark:border-amber-900/40 dark:bg-amber-950/30"
              >
                <span className="text-sm">{g.name}</span>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => handleApprove(g.id)}
                    disabled={pendingId === g.id}
                    className="rounded px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleDelete(g.id)}
                    disabled={pendingId === g.id}
                    className="rounded px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/30"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Approved ────────────────────────────────────────────── */}
      {approved.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-gray-600 dark:text-gray-400">
            {approved.length} approved
          </p>
          <div className="flex flex-wrap gap-1.5">
            {approved.map((g) => (
              <span
                key={g.id}
                className="group flex items-center gap-1 rounded-full bg-violet-100 pl-2.5 pr-1.5 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
              >
                {g.name}
                <button
                  onClick={() => handleDelete(g.id)}
                  disabled={pendingId === g.id}
                  title="Delete genre"
                  className="rounded-full p-0.5 text-violet-400 hover:bg-violet-200 hover:text-red-600 disabled:opacity-50 dark:hover:bg-violet-800 dark:hover:text-red-400"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Deleted ─────────────────────────────────────────────── */}
      {deleted.length > 0 && (
        <div>
          <button
            onClick={() => setShowDeleted((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            {showDeleted ? "▾" : "▸"} {deleted.length} deleted
          </button>
          {showDeleted && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {deleted.map((g) => (
                <span
                  key={g.id}
                  className="group flex items-center gap-1 rounded-full bg-gray-100 pl-2.5 pr-1.5 py-0.5 text-xs text-gray-400 line-through dark:bg-gray-800 dark:text-gray-500"
                >
                  {g.name}
                  <button
                    onClick={() => handleRestore(g.id)}
                    disabled={pendingId === g.id}
                    title="Restore genre"
                    className="no-underline rounded-full p-0.5 text-gray-400 hover:bg-gray-200 hover:text-emerald-600 disabled:opacity-50 dark:hover:bg-gray-700 dark:hover:text-emerald-400"
                    style={{ textDecoration: "none" }}
                  >
                    ↩
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {pending.length === 0 && approved.length === 0 && deleted.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500">No genres yet.</p>
      )}
    </div>
  );
}
