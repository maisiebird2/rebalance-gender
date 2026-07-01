import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import {
  checkBotProtection,
  getEmailStatus,
  createTokenAndSendEmail,
} from "@/lib/submission-helpers";
import type { RevisionData } from "@/lib/types";

interface ReviseBody {
  artistId: string;
  submitterEmail?: string;
  submitterNotes?: string;
  revisionData: RevisionData;
  // Bot protection
  turnstileToken?: string;
  honeypot?: string;
}

export async function POST(request: NextRequest) {
  let body: ReviseBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 1. Bot protection ───────────────────────────────────────────────────────
  const botError = await checkBotProtection(body.turnstileToken, body.honeypot);
  if (botError) {
    return NextResponse.json({ success: true });
  }

  if (!body.artistId) {
    return NextResponse.json({ error: "Artist ID is required" }, { status: 400 });
  }

  if (!body.revisionData || Object.keys(body.revisionData).length === 0) {
    return NextResponse.json({ error: "No revision data provided" }, { status: 400 });
  }

  const email = body.submitterEmail?.trim() || null;
  const supabase = getSupabaseAdminClient();

  // ── 2. Confirm the artist exists and is approved ────────────────────────────
  const { data: artist, error: artistError } = await supabase
    .from("artists")
    .select("id, name, directory_status")
    .eq("id", body.artistId)
    .eq("deleted", false)
    .maybeSingle();

  if (artistError || !artist) {
    return NextResponse.json({ error: "Artist not found" }, { status: 404 });
  }

  if (artist.directory_status !== "approved") {
    return NextResponse.json(
      { error: "Revisions can only be submitted for approved artists" },
      { status: 422 }
    );
  }

  // ── 3. Blocked email → silently discard ────────────────────────────────────
  if (email) {
    const emailStatus = await getEmailStatus(supabase, email);
    if (emailStatus === "blocked") {
      return NextResponse.json({ success: true, requiresVerification: false });
    }
  }

  // ── 4. Determine if verification is needed ──────────────────────────────────
  const skipVerification =
    !email ||
    (email ? (await getEmailStatus(supabase, email)) === "verified" : false);

  const initialStatus = skipVerification ? "pending" : "unverified";

  // ── 5. Insert revision record ───────────────────────────────────────────────
  const { data: revision, error: revisionError } = await supabase
    .from("artist_revisions")
    .insert({
      artist_id: body.artistId,
      submitted_by_email: email,
      status: initialStatus,
      submitter_notes: body.submitterNotes?.trim() || null,
      revision_data: body.revisionData,
    })
    .select("id")
    .single();

  if (revisionError || !revision) {
    return NextResponse.json(
      { error: revisionError?.message ?? "Failed to save revision" },
      { status: 500 }
    );
  }

  // ── 6. Send verification email (if required) ────────────────────────────────
  if (!skipVerification && email) {
    try {
      await createTokenAndSendEmail(
        supabase,
        email,
        "revision",
        revision.id,
        "revision",
        { artistName: artist.name }
      );
    } catch (err) {
      console.error("[revise] Failed to send verification email:", err);
      return NextResponse.json(
        { error: "Revision saved but we couldn't send the verification email. Please try again." },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true, requiresVerification: true });
  }

  return NextResponse.json({ success: true, requiresVerification: false });
}
