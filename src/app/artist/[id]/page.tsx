import Link from "next/link";
import { notFound } from "next/navigation";
import { getArtistById } from "@/lib/queries";
import { groupByRole, roleHeading } from "@/lib/organisations";
import {
  getPlatforms,
  platformLabel,
  visiblePublicLinks,
} from "@/lib/platforms";
import { getSupabaseClient } from "@/lib/supabase";
import { getViewer } from "@/lib/admin-auth";
import EditButton from "@/components/EditButton";
import AdminActions from "@/components/AdminActions";
import BandcampWidget from "@/components/BandcampWidget";
import RecommendedArtists from "@/components/RecommendedArtists";


// Rendered per request: what this page shows depends on the viewer — admins
// can open artists in any directory_status, everyone else only approved ones.

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const { isAdmin } = await getViewer();
  const artist = await getArtistById(id, { includeNonApproved: isAdmin });
  if (!artist) return {};
  return {
    title: `${artist.name} | Rebalance Gender`,
  };
}

export default async function ArtistPage({ params }: PageProps) {
  const { id } = await params;
  const { isAdmin } = await getViewer();
  const [artist, platforms] = await Promise.all([
    getArtistById(id, { includeNonApproved: isAdmin }),
    getPlatforms(getSupabaseClient()),
  ]);

  if (!artist) notFound();

  // One image picked from every platform this artist has stored (see
  // src/lib/artist-images.ts) — resolved once, in queries.ts.
  const profileImage = artist.displayImageUrl;

  const locationText = artist.locations
    ?.map((l) => [l.city, l.country].filter(Boolean).join(", "))
    .filter(Boolean)
    .join(" | ");

  const aliasText = artist.aliases
    ?.map((a) => a.name)
    .filter(Boolean)
    .join(", ");

  // Profile links shown to visitors: drop not-found/empty links and the
  // platforms that are directory data sources rather than clickable profiles
  // (Spotify, MusicBrainz, Last.fm), then order them as the page presents
  // them. Hidden links are still stored; see PUBLIC_PAGE_PLATFORM_ORDER.
  const visibleLinks = visiblePublicLinks(artist.links);

  const soundcloudEnrichment = artist.enrichment?.find(
    (e) => e.platform === "soundcloud"
  );

  // Prefer the artist's SoundCloud profile (or, if we ever harvest individual
  // track URLs into artist_enrichment, a specific track) for the embedded player.
  // If enrichment confirms track_count === 0 (account has zero uploads, likely
  // repost-only), skip the widget entirely rather than falling back to the bare
  // profile URL — that renders empty/misleading, and there's no SoundCloud
  // widget option that shows reposts instead of uploads.
  const soundcloudTrack = artist.enrichment
    ?.flatMap((e) => e.recent_tracks ?? [])
    ?.find((t) => t.url?.includes("soundcloud.com"));
  const soundcloudLink = artist.links?.find((l) => l.platform === "soundcloud" && !l.not_found);
  const isSoundCloudSearchUrl = (url?: string | null) =>
    !!url && new URL(url).pathname.startsWith("/search");
  const hasZeroSoundCloudTracks = soundcloudEnrichment?.track_count === 0;
  const soundcloudUrl = hasZeroSoundCloudTracks
    ? undefined
    : soundcloudTrack?.url ??
      (!isSoundCloudSearchUrl(soundcloudLink?.url) ? soundcloudLink?.url : undefined);

  // Fallback for accounts with zero uploads: embed their playlists (sets)
  // instead. A single widget can only play one playlist at a time — it
  // can't show "all playlists" — so if an artist has several, we render
  // one widget per playlist, capped at MAX_SOUNDCLOUD_PLAYLISTS (biggest
  // playlists first) to keep the page from growing unbounded.
  const MAX_SOUNDCLOUD_PLAYLISTS = 3;
  const soundcloudPlaylists = hasZeroSoundCloudTracks
    ? [...(soundcloudEnrichment?.playlists ?? [])]
        .sort((a, b) => (b.track_count ?? 0) - (a.track_count ?? 0))
        .slice(0, MAX_SOUNDCLOUD_PLAYLISTS)
    : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Not-approved banner — only admins can load such pages at all */}
      {artist.directory_status !== "approved" && (
        <div className="mb-4 rounded-md bg-red-600 px-4 py-3 text-sm font-medium text-white">
          This artist is not approved; status: {artist.directory_status}
        </div>
      )}

      {/* Top bar — full width */}
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          ← Back to directory
        </Link>
        <div className="flex items-center gap-2">
          {artist.directory_status === "approved" && (
            <Link
              href={`/artist/${id}/revise`}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
            >
              Suggest a correction
            </Link>
          )}
          {isAdmin && (
            <>
              <AdminActions artistId={id} currentStatus={artist.directory_status ?? "approved"} />
              <EditButton artistId={id} />
            </>
          )}
        </div>
      </div>

      {/* Two-column grid: main (2/3) | sidebar (1/3) */}
      <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-[2fr_1fr]">

        {/* ── MAIN COLUMN ── */}
        <div className="order-1">
          {/* Avatar + name */}
          <div className="flex items-center gap-4">
            <div className="avatar-ring-static h-40 w-40 shrink-0 rounded-full">
              <div className="h-full w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                {profileImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
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
            </div>

            <div>
              <h1 className="text-2xl font-bold">{artist.name}</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {[artist.pronoun?.value, locationText]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {aliasText && (
                <p className="text-sm text-gray-400 dark:text-gray-500">
                  {aliasText}
                </p>
              )}
            </div>
          </div>

          {/* Types (producer / DJ / vocalist) */}
          {artist.types?.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {artist.types.map((type) => (
                <span
                  key={type.id}
                  className="rounded-full border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 dark:border-white/15 dark:text-gray-300"
                >
                  {type.label}
                </span>
              ))}
            </div>
          )}

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
          {visibleLinks && visibleLinks.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              {visibleLinks.map((link) => (
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
            </div>
          )}

          {/* Organisations — labels, clubs, crews and events.
              DUAL-READ during the organisations migration: render the real
              organisation rows when the artist has any approved ones, and
              fall back to the old flat label text otherwise. A pending
              organisation counts as absent (normalizeArtist filters on
              status), so an artist whose organisations are still awaiting
              review keeps the line it has always had rather than losing it
              mid-migration. The fallback branch goes away with
              artist_labels in the cleanup phase. */}
          {artist.organisations.length > 0 ? (
            <div className="mt-4 flex flex-col gap-1 text-sm text-gray-600 dark:text-gray-400">
              {groupByRole(artist.organisations, (entry) => entry.role).map(({ role, items }) => (
                <p key={role.key}>
                  <span className="font-semibold">{roleHeading(role, "organisations")}: </span>
                  {items.map((entry, i) => (
                    <span key={`${entry.organisation.id}-${role.key}`}>
                      {i > 0 && ", "}
                      <Link
                        href={`/organisation/${entry.organisation.id}`}
                        className="text-violet-600 hover:underline dark:text-violet-400"
                      >
                        {entry.organisation.name}
                      </Link>
                    </span>
                  ))}
                </p>
              ))}
            </div>
          ) : artist.label_list?.length > 0 ? (
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
              <span className="font-semibold">Associated with: </span>
              {artist.label_list.map((l) => l.name).join(", ")}
            </p>
          ) : null}

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

          {/* SoundCloud playlists — fallback when the account has 0 uploads */}
          {hasZeroSoundCloudTracks && soundcloudPlaylists.length > 0 && (
            <div className="mt-6 space-y-4">
              <h2 className="mb-2 text-lg font-semibold">Playlists</h2>
              {soundcloudPlaylists.map((playlist) => (
                <iframe
                  key={playlist.url}
                  title={`${artist.name}: ${playlist.title} on SoundCloud`}
                  width="100%"
                  height="300"
                  scrolling="no"
                  frameBorder="no"
                  allow="autoplay"
                  src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(
                    playlist.url
                  )}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true&visual=true`}
                />
              ))}
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

        {/* ── SIDEBAR ── */}
        {/* The SoundCloud bio that used to sit here is no longer shown to
            visitors. The column is kept so the bio block that replaces it —
            a summary synthesised from the bios we hold — drops straight in. */}
      </div>

      <RecommendedArtists artistId={id} />
    </div>
  );
}
