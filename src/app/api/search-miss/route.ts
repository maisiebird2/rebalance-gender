import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase";

interface SearchMissBody {
  query: string;
}

export interface SearchMissResponse {
  saved: boolean;       // true if a new pending entry was created
  alreadyExists: boolean; // true if any record with this name already existed
}

export async function POST(request: NextRequest) {
  let body: SearchMissBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.query?.trim();
  if (!name) {
    return NextResponse.json({ error: "No query provided" }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();

  // Check if an artist with this name already exists (any status, not deleted)
  const { data: existing } = await supabase
    .from("artists")
    .select("id")
    .ilike("name", name)
    .eq("deleted", false)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ saved: false, alreadyExists: true } satisfies SearchMissResponse);
  }

  // Not in the directory yet — save as pending for review
  const { error } = await supabase.from("artists").insert({
    name,
    directory_status: "pending",
    notes: "Auto-added from homepage search miss",
    submitted_at: new Date().toISOString(),
  });

  if (error) {
    console.error("search-miss insert error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ saved: true, alreadyExists: false } satisfies SearchMissResponse);
}
