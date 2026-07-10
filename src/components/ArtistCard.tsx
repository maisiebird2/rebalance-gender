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

// Genre pills alternate between the two club accents for a bit of energy.
const tagClass = (i: number) =>
  i % 2 === 1
    ? "bg-pink-100 text-pink-800 dark:bg-[#ff2d9b]/12 dark:text-[#ff8ec8] dark:border dark:border-[#ff2d9b]/30"
    : "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200 dark:border dark:border-violet-500/25";

export default function ArtistCard({ artist, footer }: ArtistCardProps) {
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

  const card = (
    <Link
      href={`/artist/${artist.id}`}
      className={
        footer
          ? "flex flex-col"
          : "glass-card flex flex-col rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-white/10 dark:bg-[#131120]/60 dark:shadow-none dark:backdrop-blur-xl"
      }
    >
      <div className="flex items-start gap-3">
        <div className="avatar-ring h-24 w-24 shrink-0 rounded-full">
          <div className="h-full w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            {profileImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profileImage}
                alt={artist.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="ff-display flex h-full w-full items-center justify-center text-xl font-semibold text-violet-400 dark:text-violet-300">
                {artist.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
        </div>

        {/* Text column sits to the right of the avatar; genres live in this
            same column (below the other fields) so they align on the left
            with the name/aka/pronoun/location rather than the avatar. */}
        <div className="min-w-0 flex-1">
          <div className="space-y-0.5">
            <h3 className="ff-display truncate text-base font-medium">
              {artist.name}
            </h3>
            {aliasText && (
              <p className="truncate text-xs text-gray-400 dark:text-gray-500">
                aka {aliasText}
              </p>
            )}
            {artist.pronoun?.value && (
              <p className="ff-mono truncate text-xs text-gray-500 dark:text-gray-400">
                {artist.pronoun.value}
              </p>
            )}
            {locationText && (
              <p className="ff-mono truncate text-xs text-gray-500 dark:text-gray-400">
                {locationText}
              </p>
            )}
          </div>

          {artist.genres?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {artist.genres.map((genre, i) => (
                <span
                  key={genre.id}
                  className={`ff-mono rounded-md px-2 py-0.5 text-[11px] font-medium lowercase tracking-wide ${tagClass(i)}`}
                >
                  {genre.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  );

  if (!footer) return card;

  // With a footer, the card chrome moves to an outer <div> so the footer's
  // own links/buttons sit outside the artist-page <Link>.
  return (
    <div className="glass-card flex flex-col rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-white/10 dark:bg-[#131120]/60 dark:shadow-none dark:backdrop-blur-xl">
      {card}
      <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
        {footer}
      </div>
    </div>
  );
}
