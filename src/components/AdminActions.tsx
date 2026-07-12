"use client";

import { useEffect, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/browser";
import { quickMarkNotEligible } from "@/app/admin/actions";

interface Props {
  artistId: string;
  currentStatus: string;
}

export default function AdminActions({ artistId, currentStatus }: Props) {
  const [authed, setAuthed] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setAuthed(true);
    });
  }, []);

  if (!authed) return null;
  if (done) return (
    <span className="text-xs text-amber-600 dark:text-amber-400">Marked not eligible</span>
  );
  if (currentStatus === "not_eligible") return (
    <span className="rounded-md border border-amber-300 px-3 py-1 text-sm font-medium text-amber-700 dark:border-amber-700 dark:text-amber-400">
      Not eligible
    </span>
  );

  if (confirming) {
    return (
      <span className="flex items-center gap-2">
        <span className="text-sm text-amber-700 dark:text-amber-400">Mark as not eligible?</span>
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              await quickMarkNotEligible(artistId);
              setDone(true);
            });
          }}
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400 dark:hover:bg-amber-900"
        >
          {isPending ? "Saving…" : "Confirm"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming(false)}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => setConfirming(true)}
      className="rounded-md border border-amber-300 px-3 py-1 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950"
    >
      Not eligible
    </button>
  );
}
