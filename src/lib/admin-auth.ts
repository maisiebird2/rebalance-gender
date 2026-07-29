// Server-only viewer/admin helpers. Admins are designated by
// app_metadata.role === "admin" on their Supabase auth user. Unlike
// user_metadata, app_metadata can only be set server-side (dashboard SQL
// editor or the auth admin API) — users cannot grant it to themselves.
// Admin privileges cover the admin panel, the edit form and artist-page
// quick actions, trusted submissions, and directory visibility of artists
// in every directory_status. Signed-in users WITHOUT the role get no admin
// powers at all: they see the same directory as anonymous visitors, and
// every service-role write path checks the role, not just for a session
// (public sign-up may be enabled on the Supabase project, so anyone can
// have an account).
//
// The ADMIN_EMAILS environment variable (comma-separated, case-insensitive)
// is kept as a fallback so deploys and the dashboard metadata change can
// land in either order; it can be emptied once every admin user carries
// the role.
//
// Do not import this from client components: it reads request cookies via
// the server Supabase client, and ADMIN_EMAILS is intentionally not a
// NEXT_PUBLIC_ variable (the browser never needs the list).

import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/** True when the email is on the ADMIN_EMAILS fallback list. */
function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase());
}

/**
 * True when the user is an admin: app_metadata.role === "admin", or the
 * ADMIN_EMAILS fallback list. Only ever call this with a user returned by
 * `supabase.auth.getUser()` — that revalidates against the Auth server, so
 * the metadata is fresh; a user decoded locally from a JWT could carry a
 * stale role until the token refreshes.
 */
export function isAdminUser(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.app_metadata?.role === "admin") return true;
  return isAdminEmail(user.email);
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
  return { user, isAdmin: isAdminUser(user) };
}
