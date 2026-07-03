import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { buildPlatformSearchUrl, getPlatforms } from "@/lib/platforms";
import { getArtistsMissingLink } from "@/lib/queries";
import { hasSearchProvider } from "@/lib/search-providers";
import ArtistCard from "@/components/ArtistCard";
import Pagination from "@/components/Pagination";
import PlatformSelect from "./PlatformSelect";
import MissingLinkFooter from "./MissingLinkFooter";

export const dynamic = "force-dynamic";

// Stagger between each card's candidate fetch. MusicBrainz enforces
// 1 request/second; everything else just gets a gentle spacing.
function fetchStaggerMs(platform: string): number {
  return platform === "musicbrainz" ? 1100 : 250;
}

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function MissingLinksPage({ searchParams }: PageProps) {
  // ── Auth guard (same as /admin) ───────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/missing-links");

  const params = await searchParams;
  const platformKey =
    typeof params.platform === "string" ? params.platform : undefined;
  const pageParam =
    typeof params.page === "string" ? parseInt(params.page, 10) : 1;
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const admin = getSupabaseAdminClient();
  const allPlatforms = await getPlatforms(admin);

  // Only platforms with a search URL template are offered — without one
  // the card couldn't link anywhere useful.
  const searchablePlatforms = allPlatforms.filter(
    (p) => p.search_url_template
  );
  const platform = searchablePlatforms.find((p) => p.key === platformKey);

  const { artists, hasMore } = platform
    ? await getArtistsMissingLink(platform.key, page)
    : { artists: [], hasMore: false };

  const providerAvailable = platform ? hasSearchProvider(platform.key) : false;
  const staggerMs = platform ? fetchStaggerMs(platform.key) : 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Missing links</h1>
        <Link
          href="/admin"
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          ← Admin panel
        </Link>
      </div>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        Pick a platform to list artists with no link for it. Tick a suggested
        match to save it, or use the search link to find one by hand.
      </p>

      <div className="mb-6">
        <PlatformSelect
          platforms={searchablePlatforms.map(({ key, label }) => ({
            key,
            label,
          }))}
        />
      </div>

      {platform && !providerAvailable && (
        <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">
          {platform.key === "discogs"
            ? "Inline match suggestions for Discogs need credentials in .env.local — either DISCOGS_TOKEN or DISCOGS_CONSUMER_KEY + DISCOGS_CONSUMER_SECRET (both free at discogs.com/settings/developers). Search links still work below."
            : `Inline match suggestions aren't available for ${platform.label}; use the search links below.`}
        </p>
      )}

      {!platform ? (
        <p className="text-gray-500">
          Choose a platform above to see which artists are missing a link.
        </p>
      ) : artists.length === 0 ? (
        <p className="text-gray-500">
          {page > 1
            ? "No more artists on this page."
            : `Every approved artist already has a ${platform.label} link (or is marked as not on it). 🎉`}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {artists.map((artist, i) => (
            <ArtistCard
              key={artist.id}
              artist={artist}
              footer={
                <MissingLinkFooter
                  artistId={artist.id}
                  artistName={artist.name}
                  platformKey={platform.key}
                  platformLabel={platform.label}
                  searchUrl={buildPlatformSearchUrl(platform, artist.name)}
                  hasProvider={providerAvailable}
                  fetchDelayMs={i * staggerMs}
                />
              }
            />
          ))}
        </div>
      )}

      <Pagination
        currentPage={page}
        hasMore={hasMore}
        searchParams={params}
        basePath="/admin/missing-links"
      />
    </div>
  );
}
