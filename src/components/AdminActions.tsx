"use client";

import { useState, useTransition } from "react";
import { quickApproveArtist, quickMarkNotEligible } from "@/app/admin/actions";

interface Props {
  artistId: string;
  currentStatus: string;
}

type QuickAction = "approve" | "not_eligible";

// Rendered only for admins (the artist page gates on getViewer().isAdmin);
// the quick actions themselves enforce requireAdmin() server-side.
export default function AdminActions({ artistId, currentStatus }: Props) {
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState<QuickAction | null>(null);
  const [confirming, setConfirming] = useState<QuickAction | null>(null);

  if (done === "not_eligible") return (
    <span className="text-xs text-amber-600 dark:text-amber-400">Marked not eligible</span>
  );
  if (done === "approve") return (
    <span className="text-xs text-emerald-600 dark:text-emerald-400">Approved</span>
  );

  if (confirming) {
    const isApprove = confirming === "approve";
    return (
      <span className="flex items-center gap-2">
        <span
          className={
            isApprove
              ? "text-sm text-emerald-700 dark:text-emerald-400"
              : "text-sm text-amber-700 dark:text-amber-400"
          }
        >
          {isApprove ? "Approve this artist?" : "Mark as not eligible?"}
        </span>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              if (isApprove) {
                await quickApproveArtist(artistId);
                setDone("approve");
              } else {
                await quickMarkNotEligible(artistId);
                setDone("not_eligible");
              }
            });
          }}
          className={
            isApprove
              ? "rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-400 dark:hover:bg-emerald-900"
              : "rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400 dark:hover:bg-amber-900"
          }
        >
          {isPending ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming(null)}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      {currentStatus === "not_eligible" ? (
        <span className="rounded-md border border-amber-300 px-3 py-1 text-sm font-medium text-amber-700 dark:border-amber-700 dark:text-amber-400">
          Not eligible
        </span>
      ) : (
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming("not_eligible")}
          className="rounded-md border border-amber-300 px-3 py-1 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950"
        >
          Not eligible
        </button>
      )}
      {currentStatus !== "approved" && (
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming("approve")}
          className="rounded-md border border-emerald-300 px-3 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950"
        >
          Approve
        </button>
      )}
    </span>
  );
}
