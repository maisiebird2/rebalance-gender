// "home" page
// src/app/page.tsx

import ArtistCard from "@/components/ArtistCard";
import FilterBar from "@/components/FilterBar";
import Pagination from "@/components/Pagination";
import SearchMissResults from "@/components/SearchMissResults";
import { getArtists, getRandomArtists, getCountryOptions, getGenreOptions, getApprovedArtistCount } from "@/lib/queries";
import { getViewer } from "@/lib/admin-auth";

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
  // Set by the "Exact match" checkbox in FilterBar. Only meaningful
  // alongside a search term; on its own it filters nothing.
  const exact = params.exact === "1";
  const pageParam = typeof params.page === "string" ? parseInt(params.page, 10) : 1;
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const isFiltered = Boolean(genre || country || search);
  const { isAdmin } = await getViewer();

  // Admins browse every non-deleted artist regardless of directory_status
  // (ArtistCard badges the non-approved ones). Their unfiltered view is the
  // alphabetical all-statuses list rather than the random-approved shuffle:
  // the random_approved_artist_ids RPC only samples approved rows.
  const [{ artists, hasMore }, genres, countries, artistCount] = await Promise.all([
    isAdmin
      ? getArtists({ genre, country, search, exact, page }, { includeNonApproved: true })
      : isFiltered
        ? getArtists({ genre, country, search, exact, page })
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
            producers, DJs, and vocalists
          </p>
        ) : null}
      </div>
      <FilterBar genres={genres} countries={countries} />

      {artists.length === 0 ? (
        search ? (
          <SearchMissResults searchTerm={search} exact={exact} />
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
