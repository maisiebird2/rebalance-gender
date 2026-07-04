import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { getPlatforms, cleanLinkUrl } from "@/lib/platforms";
import { resolveProfileLinkUrl } from "@/lib/profile-links";
import {
  checkBotProtection,
  getEmailStatus,
  isDuplicateArtist,
  createTokenAndSendEmail,
} from "@/lib/submission-helpers";
import type { LinkPlatform } from "@/lib/types";

interface LocationInput {
  city?: string;
  country?: string;
}

interface SubmitBody {
  name: string;
  pronouns?: string;
  genres?: string[];
  locations?: LocationInput[];
  labels?: string[];
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

  // ── 1. Bot protection ───────────────────────────────────────────────────────
  const botError = await checkBotProtection(body.turnstileToken, body.honeypot);
  if (botError) {
    // Return a plausible success-looking response to confuse bots.
    return NextResponse.json({ success: true });
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

  // ── 1b. Auth: is this an authenticated (admin) submission? ──────────────────
  // Trust to skip email verification is granted because the server confirms a
  // logged-in session — not merely because the payload omitted an email.
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  // An email-less submission is only allowed from a logged-in user. Anonymous
  // requests (e.g. scripted POSTs) must provide an email so they go through the
  // verification flow rather than landing straight in the review queue.
  if (!email && !user) {
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
  const duplicate = await isDuplicateArtist(supabase, name);
  if (duplicate) {
    return NextResponse.json(
      { error: "This artist is already in our database or has been submitted recently." },
      { status: 409 }
    );
  }

  // ── 4. Resolve email status: logged-in users and verified emails skip
  //       email verification ────────────────────────────────────────────────
  const skipVerification =
    !!user ||
    (email ? await getEmailStatus(supabase, email) === "verified" : false);

  const initialStatus = skipVerification ? "pending" : "unverified";

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
      notes: body.notes?.trim() || null,
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

  // ── 8. Labels ───────────────────────────────────────────────────────────────
  const labelNames = (body.labels ?? []).map((l) => l.trim()).filter(Boolean);
  if (labelNames.length > 0) {
    await supabase.from("artist_labels").insert(
      labelNames.map((n) => ({ artist_id: artistId, name: n }))
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
          // without a blur event). Everything else falls back to the
          // existing cleanLinkUrl() trimming/query-stripping.
          url: resolveProfileLinkUrl(platform, original_url, cleanLinkUrl),
        };
      });

    if (rows.length > 0) {
      await supabase.from("artist_links").insert(rows);
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
