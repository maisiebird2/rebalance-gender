// "home" page
// src/app/page.tsx

import ArtistCard from "@/components/ArtistCard";
import FilterBar from "@/components/FilterBar";
import Pagination from "@/components/Pagination";
import SearchMissResults from "@/components/SearchMissResults";
import { getArtists, getRandomArtists, getCountryOptions, getGenreOptions, getApprovedArtistCount } from "@/lib/queries";

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

  const [{ artists, hasMore }, genres, countries, artistCount] = await Promise.all([
    isFiltered
      ? getArtists({ genre, country, search, page })
      : getRandomArtists(page),
    getGenreOptions(),
    getCountryOptions(),
    getApprovedArtistCount(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="ff-display text-3xl font-bold tracking-tight">
          Artist <span className="grad-text">Directory</span>
        </h1>
        {artistCount ? (
          <p className="ff-mono mt-1.5 text-sm text-gray-500 dark:text-gray-400">
            More than{" "}
            <b className="font-bold text-[#7c5cff] dark:text-[#ff2d9b]">
              {artistCount.toLocaleString()}
            </b>{" "}
            artists
          </p>
        ) : null}
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
