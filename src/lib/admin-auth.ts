// Server-only viewer/admin helpers. Admins are designated by the
// ADMIN_EMAILS environment variable: a comma-separated list of the email
// addresses (case-insensitive) of the Supabase auth users who get admin
// privileges — the admin panel, and directory visibility of artists in
// every directory_status. Signed-in users NOT on the list keep the edit
// form and the artist-page quick actions, but see the same directory as
// anonymous visitors.
//
// Do not import this from client components: it reads request cookies via
// the server Supabase client, and ADMIN_EMAILS is intentionally not a
// NEXT_PUBLIC_ variable (the browser never needs the list).

import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/** True when the email is on the ADMIN_EMAILS list. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

export interface Viewer {
  user: User | null;
  isAdmin: boolean;
}

/** The current request's signed-in user (if any) and whether they're an admin. */
export async function getViewer(): Promise<Viewer> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { user, isAdmin: isAdminEmail(user?.email) };
}
