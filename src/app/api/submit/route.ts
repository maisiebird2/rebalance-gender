import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/admin-auth";
import { getPlatforms } from "@/lib/platforms";
import { resolveProfileLinkUrl } from "@/lib/profile-links";
import { scheduleLinkResolution } from "@/lib/schedule-link-resolution";
import {
  checkBotProtection,
  getEmailStatus,
  findDuplicateArtists,
  createTokenAndSendEmail,
} from "@/lib/submission-helpers";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { LinkPlatform } from "@/lib/types";
import {
  resolveOrganisationInputs,
  attachOrganisations,
  promoteArtistLabelsToOrganisations,
} from "@/lib/organisation-writes";

interface LocationInput {
  city?: string;
  country?: string;
}

interface SubmitBody {
  name: string;
  pronouns?: string;
  genres?: string[];
  /**
   * The Organisations field as the form now posts it: an `id` when the
   * typed text matched an approved organisation, just a `name` when it
   * didn't. `labels` (plain strings) is still accepted for any client
   * that hasn't been updated.
   */
  organisations?: { id?: string | null; name: string }[];
  locations?: LocationInput[];
  labels?: string[];
  aliases?: string[];
  notes?: string;
  submittedByEmail?: string;
  links?: Partial<Record<LinkPlatform, string>>;
  // Bot protection
  turnstileToken?: string;
  honeypot?: string;  // must be empty; bots fill it
}

export async function POST(request: NextRequest) {
  let body: SubmitBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 1. Auth: is this an admin submission? ───────────────────────────────────
  // Trust to skip email verification AND bot protection is granted only when
  // the server confirms a logged-in session AND that user is an admin (see
  // src/lib/admin-auth.ts). Public sign-up may be enabled on the Supabase
  // project, so a bare session proves nothing — a non-admin session is
  // treated exactly like an anonymous request.
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  const isAdmin = isAdminUser(user);

  // ── 2. Rate limit + bot protection (both skipped for admins) ────────────────
  // Logged-in admins don't get served a Turnstile challenge, so there's no
  // token to check; the authenticated admin session is trust enough. Admins
  // also skip the rate limit — bulk entry is a legitimate admin workflow.
  if (!isAdmin) {
    const rate = checkRateLimit(`submit:${getClientIp(request)}`, 5, 10 * 60_000);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many submissions — please try again shortly." },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
      );
    }

    const botError = await checkBotProtection(body.turnstileToken, body.honeypot);
    if (botError) {
      // Return a plausible success-looking response to confuse bots.
      return NextResponse.json({ success: true });
    }
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json(
      { error: "Artist/DJ name is required" },
      { status: 400 }
    );
  }

  const email = body.submittedByEmail?.trim() || null;
  const supabase = getSupabaseAdminClient();

  // An email-less submission is only allowed from an admin. Everyone else
  // (anonymous or merely signed-in) must provide an email so they go through
  // the verification flow rather than landing straight in the review queue.
  if (!email && !isAdmin) {
    return NextResponse.json(
      { error: "An email address is required." },
      { status: 400 }
    );
  }

  // ── 2. Blocked email → silently discard ────────────────────────────────────
  if (email) {
    const emailStatus = await getEmailStatus(supabase, email);
    if (emailStatus === "blocked") {
      return NextResponse.json({ success: true, requiresVerification: false });
    }
  }

  // ── 3. Duplicate check ──────────────────────────────────────────────────────
  // A duplicate is decided by shared profile links, NOT by a matching name —
  // two different artists can share a name. Submissions with no links (or no
  // link matching an existing artist) are allowed through. When we do block,
  // return the matching entries so the client can link the submitter to the
  // existing record(s) that caused the block.
  const submittedLinks = Object.entries(body.links ?? {})
    .filter(([, url]) => typeof url === "string" && url.trim())
    .map(([platform, url]) => ({ platform, url: (url as string).trim() }));

  const duplicates = await findDuplicateArtists(supabase, submittedLinks);
  if (duplicates.length > 0) {
    return NextResponse.json(
      {
        error: "An artist with one of these profile links already exists.",
        duplicates: duplicates.map((d) => ({ id: d.id, name: d.name })),
      },
      { status: 409 }
    );
  }

  // ── 4. Resolve email status: admins and verified emails skip
  //       email verification ────────────────────────────────────────────────
  const skipVerification =
    isAdmin ||
    (email ? await getEmailStatus(supabase, email) === "verified" : false);

  // An admin submission is trusted and lands directly in the public directory
  // as "approved". Verified-email submissions from everyone else still queue
  // as "pending" for review; unverified emails start "unverified".
  const initialStatus = isAdmin
    ? "approved"
    : skipVerification
      ? "pending"
      : "unverified";

  // ── 5. Resolve pronouns ─────────────────────────────────────────────────────
  let pronounId: number | null = null;
  const pronounValue = body.pronouns?.trim().toLowerCase();
  if (pronounValue) {
    const { data: existing } = await supabase
      .from("pronouns")
      .select("id")
      .eq("value", pronounValue)
      .maybeSingle();

    if (existing) {
      pronounId = existing.id;
    } else {
      const { data: created, error } = await supabase
        .from("pronouns")
        .insert({ value: pronounValue })
        .select("id")
        .single();
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      pronounId = created.id;
    }
  }

  // ── 6. Insert artist ────────────────────────────────────────────────────────
  const { data: artist, error: artistError } = await supabase
    .from("artists")
    .insert({
      name,
      pronoun_id: pronounId,
      // Internal notes are admin-only: ignore notes from non-admin requests.
      notes: isAdmin ? body.notes?.trim() || null : null,
      directory_status: initialStatus,
      submitted_by_email: email,
      submitted_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (artistError) {
    return NextResponse.json({ error: artistError.message }, { status: 500 });
  }

  const artistId = artist.id as string;

  // ── 7. Genres ───────────────────────────────────────────────────────────────
  const genreNames = (body.genres ?? []).map((g) => g.trim().toLowerCase()).filter(Boolean);
  for (const genreName of genreNames) {
    const { data: existing } = await supabase
      .from("genres")
      .select("id")
      .eq("name", genreName)
      .maybeSingle();

    let genreId: number;
    if (existing) {
      genreId = existing.id;
    } else {
      const { data: created, error } = await supabase
        .from("genres")
        .insert({ name: genreName })
        .select("id")
        .single();
      if (error) continue;
      genreId = created.id;
    }

    await supabase.from("artist_genres").insert({ artist_id: artistId, genre_id: genreId });
  }

  // ── 8. Labels / organisations ───────────────────────────────────────────────
  //
  // A submitter may ATTACH this artist to an organisation that already
  // exists and is approved, but typing a new name does NOT create one:
  // `organisations` is a shared namespace with its own public page, and
  // this request may well be from an unverified email (the artist row
  // above is 'unverified' in that case). See src/lib/organisation-writes.ts.
  //
  // So resolved ids become associations now — the two-sided RLS policy
  // keeps them invisible until the artist is approved anyway — and
  // everything else stays flat text in artist_labels until an admin
  // approves the artist, at which point it is promoted.
  const inputs = body.organisations ?? (body.labels ?? []).map((name) => ({ name }));
  // No allowRoles: a public submission can only ever create 'associated'.
  const { resolved, names: labelNames } = await resolveOrganisationInputs(supabase, inputs);

  await attachOrganisations(supabase, artistId, resolved);

  if (labelNames.length > 0) {
    await supabase.from("artist_labels").insert(
      labelNames.map((n) => ({ artist_id: artistId, name: n }))
    );
  }

  // An admin submission goes straight in as 'approved', so it skips the
  // moderation step that would otherwise do the promotion. Do it here.
  if (initialStatus === "approved" && labelNames.length > 0) {
    await promoteArtistLabelsToOrganisations(supabase, artistId);
  }

  // ── 8b. Aliases ─────────────────────────────────────────────────────────────
  const aliasNames = (body.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  if (aliasNames.length > 0) {
    await supabase.from("artist_aliases").insert(
      aliasNames.map((n) => ({ artist_id: artistId, name: n }))
    );
  }

  // ── 9. Locations ────────────────────────────────────────────────────────────
  const validLocations = (body.locations ?? []).filter(
    (l) => l.city?.trim() || l.country?.trim()
  );
  if (validLocations.length > 0) {
    await supabase.from("artist_locations").insert(
      validLocations.map((l) => ({
        artist_id: artistId,
        city: l.city?.trim() || null,
        country: l.country?.trim() || null,
        raw_text: [l.city, l.country].filter(Boolean).join(", "),
      }))
    );
  }

  // ── 10. Links ───────────────────────────────────────────────────────────────
  if (body.links) {
    const platforms = await getPlatforms(supabase);
    const validKeys = new Set(platforms.map((p) => p.key));

    const rows = (Object.keys(body.links) as LinkPlatform[])
      .filter((platform) => validKeys.has(platform) && body.links?.[platform]?.trim())
      .map((platform) => {
        const original_url = body.links![platform]!.trim();
        return {
          artist_id: artistId,
          platform,
          original_url,
          // Bare handles for templated platforms (soundcloud, instagram,
          // bandcamp, resident_advisor) get built into a full URL here too —
          // this is a safety net in case the client-side normalization in
          // ProfileLinkField didn't run (e.g. JS disabled, Enter-to-submit
          // without a blur event). Everything else falls back to generic
          // trimming/query-stripping (cleanGenericUrl, the default fallback
          // cleaner).
          //
          // Purely synchronous now: shortener and share links
          // (on.soundcloud.com/..., bit.ly/..., soundcloud.app.goo.gl/...)
          // used to be expanded by a redirect-follow right here, which cost
          // the submitter a network round-trip per link. That moved to
          // after() below.
          url: resolveProfileLinkUrl(platform, original_url),
        };
      });

    if (rows.length > 0) {
      await supabase.from("artist_links").insert(rows);
      scheduleLinkResolution(supabase, artistId);
    }
  }

  // ── 11. Send verification email (if required) ───────────────────────────────
  if (!skipVerification && email) {
    try {
      await createTokenAndSendEmail(supabase, email, "artist", artistId, "artist");
    } catch (err) {
      // Don't fail the whole request if the email send fails — the record
      // exists and can be cleaned up later. Log and surface to the client.
      console.error("[submit] Failed to send verification email:", err);
      return NextResponse.json(
        { error: "Submission saved but we couldn't send the verification email. Please try again." },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true, requiresVerification: true });
  }

  return NextResponse.json({ success: true, requiresVerification: false });
}
