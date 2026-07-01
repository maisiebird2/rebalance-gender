import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/verify?error=missing", request.url));
  }

  const supabase = getSupabaseAdminClient();

  // ── Look up the token ───────────────────────────────────────────────────────
  const { data: tokenRow, error: tokenError } = await supabase
    .from("verification_tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (tokenError || !tokenRow) {
    return NextResponse.redirect(new URL("/verify?error=invalid", request.url));
  }

  if (tokenRow.used_at) {
    return NextResponse.redirect(new URL("/verify?error=used", request.url));
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return NextResponse.redirect(new URL("/verify?error=expired", request.url));
  }

  // ── Mark token as used ──────────────────────────────────────────────────────
  await supabase
    .from("verification_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  // ── Promote the submission to 'pending' ─────────────────────────────────────
  if (tokenRow.target_type === "artist") {
    const { error } = await supabase
      .from("artists")
      .update({ directory_status: "pending" })
      .eq("id", tokenRow.target_id)
      .eq("directory_status", "unverified"); // guard against double-promotion

    if (error) {
      console.error("[verify] Failed to promote artist:", error);
      return NextResponse.redirect(new URL("/verify?error=server", request.url));
    }
  } else if (tokenRow.target_type === "revision") {
    const { error } = await supabase
      .from("artist_revisions")
      .update({ status: "pending" })
      .eq("id", tokenRow.target_id)
      .eq("status", "unverified");

    if (error) {
      console.error("[verify] Failed to promote revision:", error);
      return NextResponse.redirect(new URL("/verify?error=server", request.url));
    }
  }

  // ── Update submitter_emails: mark email as verified ─────────────────────────
  const now = new Date().toISOString();
  await supabase
    .from("submitter_emails")
    .update({ status: "verified", verified_at: now })
    .eq("email", tokenRow.email)
    .eq("status", "unverified"); // don't downgrade a blocked email

  return NextResponse.redirect(
    new URL(`/verify?success=1&type=${tokenRow.target_type}`, request.url)
  );
}
