import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getPlatforms } from "@/lib/platforms";
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
}

export async function POST(request: NextRequest) {
  let body: SubmitBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json(
      { error: "Artist/DJ name is required" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdminClient();

  // 1. Resolve pronoun (find or create), preserving the value as typed.
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

  // 2. Insert the artist as 'pending' — awaits moderation before going live.
  const { data: artist, error: artistError } = await supabase
    .from("artists")
    .insert({
      name,
      pronoun_id: pronounId,
      notes: body.notes?.trim() || null,
      status: "pending",
      submitted_by_email: body.submittedByEmail?.trim() || null,
      submitted_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (artistError) {
    return NextResponse.json({ error: artistError.message }, { status: 500 });
  }

  const artistId = artist.id as string;

  // 3. Resolve genres (find or create each, then link via artist_genres).
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
      if (error) continue; // skip this genre on error, don't fail whole submission
      genreId = created.id;
    }

    await supabase
      .from("artist_genres")
      .insert({ artist_id: artistId, genre_id: genreId });
  }

  // 4. Labels — one row per entry.
  const labelNames = (body.labels ?? []).map((l) => l.trim()).filter(Boolean);
  if (labelNames.length > 0) {
    await supabase.from("artist_labels").insert(
      labelNames.map((name) => ({ artist_id: artistId, name }))
    );
  }

  // 5. Locations — one row per entry with separate city and country.
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

  // 5. Links — one row per non-empty platform URL. Validate against the
  // `platforms` lookup table rather than a hardcoded list, since the
  // admin panel can add new categories at runtime.
  if (body.links) {
    const platforms = await getPlatforms(supabase);
    const validKeys = new Set(platforms.map((p) => p.key));

    const rows = (Object.keys(body.links) as LinkPlatform[])
      .filter((platform) => validKeys.has(platform) && body.links?.[platform]?.trim())
      .map((platform) => ({
        artist_id: artistId,
        platform,
        url: body.links![platform]!.trim(),
      }));

    if (rows.length > 0) {
      await supabase.from("artist_links").insert(rows);
    }
  }

  return NextResponse.json({ success: true, id: artistId });
}
