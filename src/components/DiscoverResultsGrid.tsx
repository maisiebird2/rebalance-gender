import Link from "next/link";
import type { DiscoverResult } from "@/app/api/discover/route";

interface Props {
  results: DiscoverResult[];
}

export default function DiscoverResultsGrid({ results }: Props) {
  return (
    <div className="grid grid-cols-3 gap-6 sm:grid-cols-4 md:grid-cols-5">
      {results.map((artist) => (
        <Link
          key={artist.id}
          href={`/artist/${artist.id}`}
          className="group flex flex-col items-center gap-2 text-center"
        >
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            {artist.profile_image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={artist.profile_image_url}
                alt={artist.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xl font-semibold text-gray-400">
                {artist.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <span className="line-clamp-2 text-xs font-medium group-hover:underline">
            {artist.name}
          </span>
        </Link>
      ))}
    </div>
  );
}
