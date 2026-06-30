import Link from "next/link";
import { notFound } from "next/navigation";
import { getArtistById } from "@/lib/queries";
import { getPlatforms, platformLabel } from "@/lib/platforms";
import { getSupabaseClient } from "@/lib/supabase";
import EditButton from "@/components/EditButton";
import BandcampWidget from "@/components/BandcampWidget";
import RecommendedArtists from "@/components/RecommendedArtists";
import { linkify } from "@/lib/linkify";


export const revalidate = 3600; // re-fetch from Supabase at most hourly

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ArtistPage({ params }: PageProps) {
  const { id } = await params;
  const [artist, platforms] = await Promise.all([
    getArtistById(id),
    getPlatforms(getSupabaseClient()),
  ]);

  if (!artist) notFound();

  const profileImage =
    artist.profile_image_url ??
    artist.enrichment?.find((e) => e.profile_image_url)?.profile_image_url;

  const locationText = artist.locations
    ?.map((l) => [l.city, l.country].filter(Boolean).join(", "))
    .filter(Boolean)
    .join(" | ");

  // Prefer the artist's SoundCloud profile (or, if we ever harvest individual
  // track URLs into artist_enrichment, a specific track) for the embedded player.
  const soundcloudTrack = artist.enrichment
    ?.flatMap((e) => e.recent_tracks ?? [])
    ?.find((t) => t.url?.includes("soundcloud.com"));
  const soundcloudLink = artist.links?.find((l) => l.platform === "soundcloud" && !l.not_found);
  const soundcloudUrl = soundcloudTrack?.url ?? soundcloudLink?.url;

  const soundcloudEnrichment = artist.enrichment?.find(
    (e) => e.platform === "soundcloud"
  );
  const soundcloudBio = soundcloudEnrichment?.bio_sanitized ?? soundcloudEnrichment?.bio ?? null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Top bar — full width */}
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          ← Back to directory
        </Link>
        <EditButton artistId={id} />
      </div>

      {/* Two-column grid: main (2/3) | sidebar (1/3) */}
      <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-[2fr_1fr]">

        {/* ── MAIN COLUMN ── */}
        <div className="order-1">
          {/* Avatar + name */}
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
              {profileImage ? (
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={profileImage}
                  alt={artist.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-gray-400">
                  {artist.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>

            <div>
              <h1 className="text-2xl font-bold">{artist.name}</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {[artist.pronoun?.value, locationText]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>

          {/* Genres */}
          {artist.genres?.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {artist.genres.map((genre) => (
                <span
                  key={genre.id}
                  className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
                >
                  {genre.name}
                </span>
              ))}
            </div>
          )}

          {/* Profile links */}
          {(artist.links?.some((l) => !l.not_found) || artist.linktree_url) && (
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              {artist.links?.filter((l) => !l.not_found && l.url).map((link) => (
                <a
                  key={link.id}
                  href={link.url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-600 hover:underline dark:text-violet-400"
                >
                  {platformLabel(platforms, link.platform)}
                </a>
              ))}

              {artist.linktree_url && (
                <a
                  href={artist.linktree_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-600 hover:underline dark:text-violet-400"
                >
                  Linktree
                </a>
              )}
            </div>
          )}

          {/* Labels */}
          {artist.label_list?.length > 0 && (
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
              <span className="font-semibold">Labels: </span>
              {artist.label_list.map((l) => l.name).join(", ")}
            </p>
          )}

          {/* SoundCloud widget */}
          {soundcloudUrl && (
            <div className="mt-6">
              <h2 className="mb-2 text-lg font-semibold">Tracks</h2>
              <iframe
                title={`${artist.name} on SoundCloud`}
                width="100%"
                height="300"
                scrolling="no"
                frameBorder="no"
                allow="autoplay"
                src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(
                  soundcloudUrl
                )}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true&visual=true`}
              />
            </div>
          )}

          {/* Bandcamp widget */}
          {artist.bandcamp_albums && artist.bandcamp_albums.length > 0 && (
            <BandcampWidget
              albums={artist.bandcamp_albums}
              artistName={artist.name}
            />
          )}

          {/* Booking / management / contact — below the widgets */}
          {(artist.booking_info || artist.management_info || artist.contact_info) && (
            <div className="mt-6 space-y-2">
              {artist.booking_info && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  <strong className="font-semibold">Booking:</strong>{" "}
                  {artist.booking_info}
                </p>
              )}
              {artist.management_info && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  <strong className="font-semibold">Management:</strong>{" "}
                  {artist.management_info}
                </p>
              )}
              {artist.contact_info && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  <strong className="font-semibold">Contact:</strong>{" "}
                  {artist.contact_info}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── SIDEBAR — SoundCloud bio ── */}
        {soundcloudBio && (
          <aside className="order-2 lg:order-2">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400">
              <strong className="font-semibold text-gray-900 dark:text-gray-100">
                SoundCloud bio
              </strong>
              {soundcloudEnrichment?.bio_sanitized ? (
                // Sanitized HTML from DOMPurify — safe to render as HTML.
                // Links, line breaks, and basic formatting are preserved.
                <div
                  className="mt-2 space-y-1.5 [&_a]:text-violet-600 [&_a]:hover:underline dark:[&_a]:text-violet-400"
                  dangerouslySetInnerHTML={{ __html: soundcloudEnrichment.bio_sanitized }}
                />
              ) : (
                // Plain-text fallback for bios not yet run through sanitize-bios.mjs.
                // Bare URLs are linkified; no HTML is rendered.
                <div className="mt-2 space-y-1.5">
                  {soundcloudBio.split("\n").map((line, i) => (
                    <p key={i}>
                      {linkify(line).map((seg, j) =>
                        seg.type === "url" ? (
                          <a
                            key={j}
                            href={seg.value}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-violet-600 hover:underline dark:text-violet-400"
                          >
                            {seg.value}
                          </a>
                        ) : (
                          seg.value
                        )
                      )}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      <RecommendedArtists artistId={id} />
    </div>
  );
}
