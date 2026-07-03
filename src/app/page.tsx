import Link from "next/link";
import ArtistCard from "@/components/ArtistCard";
import FilterBar from "@/components/FilterBar";
import Pagination from "@/components/Pagination";
import SearchMissResults from "@/components/SearchMissResults";
import { getArtists, getRandomArtists, getCountryOptions, getGenreOptions } from "@/lib/queries";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;
  const genre = typeof params.genre === "string" ? params.genre : undefined;
  const country =
    typeof params.country === "string" ? params.country : undefined;
  const search =
    typeof params.search === "string" ? params.search : undefined;
  const pageParam = typeof params.page === "string" ? parseInt(params.page, 10) : 1;
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const isFiltered = Boolean(genre || country || search);

  const [{ artists, hasMore }, genres, countries] = await Promise.all([
    isFiltered
      ? getArtists({ genre, country, search, page })
      : getRandomArtists(page),
    getGenreOptions(),
    getCountryOptions(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Artist Directory</h1>
        <Link
          href="/discover"
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          Find artists similar to one you love →
        </Link>
      </div>
      <FilterBar genres={genres} countries={countries} />

      {artists.length === 0 ? (
        search ? (
          <SearchMissResults searchTerm={search} />
        ) : (
          <p className="text-gray-500">No artists match these filters yet.</p>
        )
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {artists.map((artist) => (
            <ArtistCard key={artist.id} artist={artist} />
          ))}
        </div>
      )}

      <Pagination currentPage={page} hasMore={hasMore} searchParams={params} />
    </div>
  );
}
