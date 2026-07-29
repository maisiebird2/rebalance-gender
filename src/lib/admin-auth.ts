// Server-only viewer/admin helpers. Admins are designated by the
// ADMIN_EMAILS environment variable: a comma-separated list of the email
// addresses (case-insensitive) of the Supabase auth users who get admin
// privileges — the admin panel, the edit form and artist-page quick
// actions, trusted submissions, and directory visibility of artists in
// every directory_status. Signed-in users NOT on the list get no admin
// powers at all: they see the same directory as anonymous visitors, and
// every service-role write path checks this list, not just for a session
// (public sign-up may be enabled on the Supabase project, so anyone can
// have an account).
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
