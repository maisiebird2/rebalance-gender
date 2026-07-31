import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { checkBotProtection } from "@/lib/submission-helpers";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

interface SearchMissBody {
  query: string;
  // Bot protection
  turnstileToken?: string;
  honeypot?: string; // must be empty; bots fill it
}

export interface SearchMissResponse {
  saved: boolean;       // true if a new pending entry was created
  alreadyExists: boolean; // true if any record with this name already existed
}

// Longest name we'll queue for review — anything beyond this is junk input.
const MAX_NAME_LENGTH = 200;

/**
 * Escape ilike pattern wildcards so the user's query is matched literally.
 * Without this, a query like "%" matches every artist and a name containing
 * "_" matches any single character in that position.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`search-miss:${getClientIp(request)}`, 10, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests — please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }

  let body: SearchMissBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Bot protection (Turnstile + honeypot), same as /api/submit and
  // /api/revise. On failure return a plausible success-looking response
  // rather than an error, so bots don't learn they were detected.
  const botError = await checkBotProtection(body.turnstileToken, body.honeypot);
  if (botError) {
    return NextResponse.json({ saved: true, alreadyExists: false } satisfies SearchMissResponse);
  }

  const name = body.query?.trim();
  if (!name) {
    return NextResponse.json({ error: "No query provided" }, { status: 400 });
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "Query is too long" }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();

  // Check if an artist with this name already exists (any status, not deleted)
  const { data: existing } = await supabase
    .from("artists")
    .select("id")
    .ilike("name", escapeLikePattern(name))
    .eq("deleted", false)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ saved: false, alreadyExists: true } satisfies SearchMissResponse);
  }

  // Not in the directory yet — user opted to submit it, so save as pending for review
  const { error } = await supabase.from("artists").insert({
    name,
    directory_status: "search_input",
    notes: "Submitted by a visitor after a homepage search found no match",
    submitted_at: new Date().toISOString(),
  });

  if (error) {
    // Log the real error server-side only; the client just needs to know it failed.
    console.error("search-miss insert error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ saved: true, alreadyExists: false } satisfies SearchMissResponse);
}
