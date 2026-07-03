import Link from "next/link";
import type { ReactNode } from "react";
import type { ArtistWithRelations } from "@/lib/types";

interface ArtistCardProps {
  artist: ArtistWithRelations;
  /**
   * Optional extra content rendered at the bottom of the card, e.g. the
   * platform-search links on /admin/missing-links. Rendered OUTSIDE the
   * card's <Link> (nested anchors are invalid HTML), so the footer can
   * safely contain its own links and buttons.
   */
  footer?: ReactNode;
}

export default function ArtistCard({ artist, footer }: ArtistCardProps) {
  // Prefer the artist's harvested profile picture; fall back to a cached
  // enrichment image (currently SoundCloud) if no dedicated one is set yet.
  const profileImage =
    artist.profile_image_url ??
    artist.enrichment?.find((e) => e.profile_image_url)?.profile_image_url;

  const locationText = artist.locations
    ?.map((l) => [l.city, l.country].filter(Boolean).join(", "))
    .filter(Boolean)
    .join(" | ");

  const card = (
    <Link
      href={`/artist/${artist.id}`}
      className={
        footer
          ? "flex flex-col"
          : "flex flex-col rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-gray-800 dark:bg-gray-900"
      }
    >
      <div className="flex items-center gap-3">
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
          {profileImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profileImage}
              alt={artist.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-gray-400">
              {artist.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{artist.name}</h3>
          <p className="truncate text-sm text-gray-500 dark:text-gray-400">
            {[artist.pronoun?.value, locationText]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>

      {artist.genres?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
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
    </Link>
  );

  if (!footer) return card;

  // With a footer, the card chrome moves to an outer <div> so the footer's
  // own links/buttons sit outside the artist-page <Link>.
  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-gray-800 dark:bg-gray-900">
      {card}
      <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
        {footer}
      </div>
    </div>
  );
}
