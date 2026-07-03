import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  hasSearchProvider,
  searchPlatformForArtist,
} from "@/lib/search-providers";

/**
 * GET /api/admin/platform-search?platform=discogs&name=PHLOXO
 *
 * Auth-guarded (admin login) proxy in front of lib/search-providers —
 * lets the MissingLinkFooter client component fetch top candidates
 * without exposing platform API keys to the browser.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const platform = request.nextUrl.searchParams.get("platform") ?? "";
  const name = (request.nextUrl.searchParams.get("name") ?? "").trim();

  if (!platform || !name) {
    return NextResponse.json(
      { error: "Missing platform or name" },
      { status: 400 }
    );
  }
  if (!hasSearchProvider(platform)) {
    return NextResponse.json(
      { error: `No search provider available for "${platform}"` },
      { status: 400 }
    );
  }

  try {
    const candidates = await searchPlatformForArtist(platform, name);
    return NextResponse.json({ candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    console.error(`platform-search ${platform} "${name}":`, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
