import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Public client — safe to use in server and client components.
// Reads are restricted by Row Level Security to status = 'approved'.
// Uses the publishable key only; never expose the secret key to the browser.
let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variables. " +
        "Copy .env.local.example to .env.local and fill in your Supabase project values."
    );
  }

  cachedClient = createClient(url, publishableKey);
  return cachedClient;
}

// Admin client — server-only, uses the secret key which bypasses RLS.
// NEVER import this from a client component. Used for the submission API
// route's moderation queue and any future admin tooling.
export function getSupabaseAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secretKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY environment variables."
    );
  }

  return createClient(url, secretKey, {
    auth: { persistSession: false },
  });
}
