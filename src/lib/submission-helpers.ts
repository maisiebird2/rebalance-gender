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
import { cleanLinkUrl } from "@/lib/platforms";
import { resolveProfileLinkUrlAsync, deriveHandle } from "@/lib/profile-links";

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
//
// We do NOT treat a matching *name* as a duplicate: two different artists can
// legitimately share a name. A submission is only a duplicate when one of its
// submitted platform links points at the same profile as an existing artist's
// link — same platform AND (same canonical URL OR same derived handle).

/** A duplicate artist match, used to link the submitter to existing entries. */
export interface DuplicateMatch {
  id: string;
  name: string;
}

/** A submitted profile link to check against existing artists' links. */
export interface SubmittedLink {
  platform: string;
  url: string;
}

/**
 * Canonicalize a profile URL for equality comparison: drop the scheme,
 * a leading "www.", the query string, the fragment, and any trailing slash,
 * and lowercase the host. This is intentionally lossy — it's only used to
 * decide whether two links point at the same profile.
 */
function canonicalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

/** Build the set of match keys (per platform) for a single link's canonical
 *  URL and derived handle. */
function linkKeys(platform: string, canonicalLinkUrl: string): string[] {
  const keys: string[] = [];
  const urlKey = canonicalizeUrl(canonicalLinkUrl);
  if (urlKey) keys.push(`${platform}|url|${urlKey}`);
  const handle = deriveHandle(platform, canonicalLinkUrl);
  if (handle) keys.push(`${platform}|handle|${handle.toLowerCase()}`);
  return keys;
}

interface ArtistLinkRow {
  platform: string;
  url: string | null;
  handle: string | null;
  artists: { id: string; name: string; deleted: boolean } | null;
}

/**
 * Returns the existing (non-deleted) artists that share a profile link with
 * the submitted links. An empty array means no duplicate — including when no
 * links were submitted, since there's nothing to match on. The returned rows
 * let callers link the submitter to the entries that caused the block.
 */
export async function findDuplicateArtists(
  supabase: SupabaseClient,
  links: SubmittedLink[]
): Promise<DuplicateMatch[]> {
  if (!links.length) return [];

  // Normalize submitted links the same way they'd be stored, then build the
  // lookup keys and the set of platforms we need to query.
  const wantedKeys = new Set<string>();
  const platforms = new Set<string>();
  for (const { platform, url } of links) {
    if (!platform || !url?.trim()) continue;
    // Resolve share links (e.g. on.soundcloud.com/...) the same way the save
    // path will, so a submitted share link is matched against the existing
    // artist's already-canonical URL.
    const canonical = await resolveProfileLinkUrlAsync(platform, url, cleanLinkUrl);
    if (!canonical) continue;
    const keys = linkKeys(platform, canonical);
    if (keys.length === 0) continue;
    platforms.add(platform);
    for (const k of keys) wantedKeys.add(k);
  }
  if (wantedKeys.size === 0) return [];

  // Fetch existing links for just the submitted platforms, with owning artist.
  const { data } = await supabase
    .from("artist_links")
    .select("platform, url, handle, artists!inner(id, name, deleted)")
    .in("platform", Array.from(platforms));

  if (!data) return [];

  const matches = new Map<string, DuplicateMatch>();
  for (const row of data as unknown as ArtistLinkRow[]) {
    const artist = row.artists;
    if (!artist || artist.deleted) continue;

    const rowKeys: string[] = [];
    if (row.url) rowKeys.push(...linkKeys(row.platform, row.url));
    if (row.handle) rowKeys.push(`${row.platform}|handle|${row.handle.toLowerCase()}`);

    if (rowKeys.some((k) => wantedKeys.has(k))) {
      matches.set(artist.id, { id: artist.id, name: artist.name });
    }
  }

  return Array.from(matches.values());
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
