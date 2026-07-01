/**
 * lib/turnstile.ts
 *
 * Server-side verification of Cloudflare Turnstile tokens.
 * The client-side widget (in SubmissionForm / RevisionForm) produces
 * a cf-turnstile-response token on each form render; this module
 * validates it against Cloudflare's siteverify endpoint.
 *
 * Required env vars:
 *   TURNSTILE_SECRET_KEY  — secret key from the Cloudflare dashboard
 *                           (Turnstile → your site → Secret key)
 *                           Never prefix with NEXT_PUBLIC_.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verifies a Turnstile token obtained from the client.
 * Returns true if the challenge passed, false otherwise.
 * Throws if the env var is missing or the network call fails.
 */
export async function verifyTurnstileToken(token: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // In development without a key, skip verification so the form still works.
    if (process.env.NODE_ENV === "development") {
      console.warn("[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification in development");
      return true;
    }
    throw new Error("TURNSTILE_SECRET_KEY is not configured");
  }

  const body = new URLSearchParams({
    secret,
    response: token,
  });

  const res = await fetch(SITEVERIFY_URL, {
    method: "POST",
    body,
  });

  if (!res.ok) {
    throw new Error(`Turnstile siteverify returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
  return data.success === true;
}
