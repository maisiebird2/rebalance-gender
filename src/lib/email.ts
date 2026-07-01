/**
 * lib/email.ts
 *
 * Thin wrapper around the Resend API for sending transactional emails.
 * All email sending in this app should go through this module.
 *
 * Required env vars:
 *   RESEND_API_KEY        — Resend API key (server-only)
 *   NEXT_PUBLIC_SITE_URL  — full origin, e.g. https://womeninelectronicmusic.com
 */

import { Resend } from "resend";

let cachedResend: Resend | null = null;

function getResend(): Resend {
  if (!cachedResend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("RESEND_API_KEY is not set");
    }
    cachedResend = new Resend(apiKey);
  }
  return cachedResend;
}

const FROM_ADDRESS = "noreply@womeninelectronicmusic.com";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export type SubmissionKind = "artist" | "revision";

/**
 * Send a verification email with a one-time link.
 * @param email     Recipient address
 * @param token     UUID token stored in verification_tokens
 * @param kind      Whether this is for a new artist or a revision
 * @param extra     Optional extra context (e.g. artist name for revisions)
 */
export async function sendVerificationEmail(
  email: string,
  token: string,
  kind: SubmissionKind,
  extra?: { artistName?: string }
): Promise<void> {
  const verifyUrl = `${SITE_URL}/verify?token=${token}`;

  const subject =
    kind === "artist"
      ? "Confirm your artist submission"
      : `Confirm your revision for ${extra?.artistName ?? "an artist"}`;

  const intro =
    kind === "artist"
      ? "Thanks for submitting an artist to the Women in Electronic Music directory."
      : `Thanks for submitting a revision for <strong>${extra?.artistName ?? "an artist"}</strong> in the Women in Electronic Music directory.`;

  const html = `
    <p>${intro}</p>
    <p>Please confirm your email address to send the submission to our moderation queue:</p>
    <p style="margin: 24px 0;">
      <a href="${verifyUrl}"
         style="background:#7c3aed;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">
        Confirm submission
      </a>
    </p>
    <p style="color:#6b7280;font-size:14px;">
      This link expires in 48 hours. If you didn't submit anything, you can ignore this email.
    </p>
    <p style="color:#6b7280;font-size:14px;">
      If the button doesn't work, copy this URL into your browser:<br/>
      <a href="${verifyUrl}" style="color:#7c3aed;">${verifyUrl}</a>
    </p>
  `;

  const text =
    `${kind === "artist" ? "Thanks for submitting an artist" : `Thanks for submitting a revision for ${extra?.artistName ?? "an artist"}`} to the Women in Electronic Music directory.\n\n` +
    `Please confirm your email by visiting this link (expires in 48 hours):\n${verifyUrl}\n\n` +
    `If you didn't submit anything, you can ignore this email.`;

  const { error } = await getResend().emails.send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Failed to send verification email: ${error.message}`);
  }
}
