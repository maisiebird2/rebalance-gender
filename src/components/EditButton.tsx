"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";

interface Props {
  artistId: string;
}

export default function EditButton({ artistId }: Props) {
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setAuthed(true);
    });
  }, []);

  if (!authed) return null;

  return (
    <Link
      href={`/artist/${artistId}/edit`}
      className="rounded-md border border-violet-400 px-3 py-1 text-sm font-medium text-violet-600 hover:bg-violet-50 dark:border-violet-500 dark:text-violet-400 dark:hover:bg-violet-900/20"
    >
      Edit
    </Link>
  );
}
