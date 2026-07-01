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

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await quickMarkNotEligible(artistId);
          setDone(true);
        });
      }}
      className="rounded-md border border-amber-300 px-3 py-1 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950"
    >
      {isPending ? "Saving…" : "Not eligible"}
    </button>
  );
}
