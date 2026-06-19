// Browser-side Supabase client — uses cookies (managed by @supabase/ssr)
// for session management. Import and call createClient() in any Client
// Component where you need to check auth or call Supabase from the browser.
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
