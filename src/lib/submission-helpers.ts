/**
 * lib/submission-helpers.ts
 *
 * Shared logic used by /api/submit and /api/revise:
 *   - bot-protection checks (Turnstile + honeypot)
 *   - blocked-email check
 *   - duplicate-artist check
 *   - verification-token creation + email dispatch
 *   - submitter_emails upsert
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { sendVerificationEmail, type SubmissionKind } from "@/lib/email";

// ── Bot protection ────────────────────────────────────────────────────────────

/**
 * Verify Turnstile token and reject if honeypot is filled.
 * Returns an error string if the request should be rejected, null otherwise.
 */
export async function checkBotProtection(
  turnstileToken: string | null | undefined,
  honeypot: string | null | undefined
): Promise<string | null> {
  // Honeypot: if filled, silently signal rejection (we return a vague error
  // so the UI shows a normal message — don't reveal we detected a bot).
  if (honeypot && honeypot.trim() !== "") {
    return "Invalid submission";
  }

  // Turnstile: required in production; skipped in dev if key is absent.
  if (!turnstileToken) {
    if (process.env.NODE_ENV === "development" && !process.env.TURNSTILE_SECRET_KEY) {
      return null; // allow in dev without key
    }
    return "Bot check failed — please try again";
  }

  try {
    const passed = await verifyTurnstileToken(turnstileToken);
    if (!passed) return "Bot check failed — please try again";
  } catch {
    return "Bot check failed — please try again";
  }

  return null;
}

// ── Email status checks ───────────────────────────────────────────────────────

export type EmailStatus = "new" | "unverified" | "verified" | "blocked";

/**
 * Look up the submitter's email in the submitter_emails table.
 * Returns the status: 'new' if not seen before.
 */
export async function getEmailStatus(
  supabase: SupabaseClient,
  email: string
): Promise<EmailStatus> {
  const { data } = await supabase
    .from("submitter_emails")
    .select("status")
    .eq("email", email)
    .maybeSingle();

  if (!data) return "new";
  return data.status as EmailStatus;
}

// ── Duplicate artist check ───────────────────────────────────────────────────

/** Normalize a name for fuzzy duplicate matching. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true if an artist with a similar name already exists
 * (in any status, including pending/unverified).
 */
export async function isDuplicateArtist(
  supabase: SupabaseClient,
  name: string
): Promise<boolean> {
  const normalized = normalizeName(name);
  if (!normalized) return false;

  // Fetch all artist names (only name + status; not a huge dataset).
  const { data } = await supabase
    .from("artists")
    .select("name")
    .eq("deleted", false);

  if (!data) return false;

  return data.some(
    (row: { name: string }) => normalizeName(row.name) === normalized
  );
}

// ── Token + email ─────────────────────────────────────────────────────────────

const TOKEN_EXPIRY_HOURS = 48;

/**
 * Create a verification token in the DB, send the verification email,
 * and upsert the submitter_emails row (increment submission_count).
 *
 * @param supabase    Admin Supabase client
 * @param email       Submitter's email address
 * @param targetType  'artist' or 'revision'
 * @param targetId    UUID of the artist or revision record
 * @param kind        Same as targetType, passed to email template
 * @param extra       Optional extra context for the email (e.g. artist name)
 */
export async function createTokenAndSendEmail(
  supabase: SupabaseClient,
  email: string,
  targetType: "artist" | "revision",
  targetId: string,
  kind: SubmissionKind,
  extra?: { artistName?: string }
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
  ).toISOString();

  // Insert token — the DB generates the UUID token via default.
  const { data: tokenRow, error: tokenError } = await supabase
    .from("verification_tokens")
    .insert({
      email,
      target_type: targetType,
      target_id: targetId,
      expires_at: expiresAt,
    })
    .select("token")
    .single();

  if (tokenError || !tokenRow) {
    throw new Error(
      `Failed to create verification token: ${tokenError?.message ?? "no row returned"}`
    );
  }

  // Upsert submitter_emails: insert if new, increment count if existing.
  await supabase.rpc("upsert_submitter_email", { p_email: email });

  // Send the email (throws if Resend fails).
  await sendVerificationEmail(email, tokenRow.token, kind, extra);
}
