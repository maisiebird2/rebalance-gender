import Link from "next/link";
import { getRecommendedArtists } from "@/lib/queries";

interface Props {
  artistId: string;
}

export default async function RecommendedArtists({ artistId }: Props) {
  const recommended = await getRecommendedArtists(artistId);
  if (recommended.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="mb-4 text-lg font-semibold">You might also like</h2>
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-10">
        {recommended.map((artist) => {
          const image = artist.image_url;
          return (
            <Link
              key={artist.id}
              href={`/artist/${artist.id}`}
              className="group flex flex-col items-center gap-2 text-center"
            >
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={image}
                    alt={artist.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-gray-400">
                    {artist.name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <span className="line-clamp-2 text-xs font-medium group-hover:underline">
                {artist.name}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
