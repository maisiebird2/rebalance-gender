import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrganisationById } from "@/lib/queries";
import { groupByRole, roleHeading } from "@/lib/organisations";
import {
  getPlatforms,
  platformLabel,
  PLATFORMS_HIDDEN_ON_ARTIST_PAGE,
} from "@/lib/platforms";
import { getSupabaseClient } from "@/lib/supabase";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * NOINDEXED for now, deliberately.
 *
 * The backfill created ~240 organisations from flat label strings, and most
 * of them currently carry a name and nothing else — no type, no location, no
 * links, because that is hand work still in progress. Letting search engines
 * index a few hundred near-empty pages is the kind of thing that is quick to
 * do and slow to undo. Drop the robots block once the entries are filled in.
 *
 * There is no sitemap in this app, so nothing else needs changing to keep
 * these out of the index.
 */
export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const organisation = await getOrganisationById(id);
  if (!organisation) return { robots: { index: false, follow: false } };
  return {
    title: `${organisation.name} | Rebalance Gender`,
    robots: { index: false, follow: false },
  };
}

export default async function OrganisationPage({ params }: PageProps) {
  const { id } = await params;
  const [organisation, platforms] = await Promise.all([
    getOrganisationById(id),
    getPlatforms(getSupabaseClient()),
  ]);

  // Covers "doesn't exist", "not approved yet" and "merged into another
  // organisation" alike — see getOrganisationById.
  if (!organisation) notFound();

  const locationText = organisation.locations
    .map((l) => [l.city, l.country].filter(Boolean).join(", "))
    .filter(Boolean)
    .join(" | ");

  // Same treatment the artist page gives its links: drop the not-found and
  // empty rows, and hide the platforms that exist for enrichment rather
  // than for visitors.
  const visibleLinks = organisation.links.filter(
    (link) =>
      !link.not_found &&
      link.url &&
      !PLATFORMS_HIDDEN_ON_ARTIST_PAGE.has(link.platform),
  );

  // The role-inverted people list: "Head: …", "Resident: …". Same grouping
  // the artist page uses, read the other way round.
  const roleGroups = groupByRole(organisation.artists, (entry) => entry.role);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link
        href="/"
        className="text-sm text-violet-600 hover:underline dark:text-violet-400"
      >
        ← Back to directory
      </Link>

      <h1 className="mt-6 text-3xl font-bold">{organisation.name}</h1>

      {organisation.types.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {organisation.types.map((type) => (
            <span
              key={type.key}
              className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
            >
              {type.label}
            </span>
          ))}
        </div>
      )}

      {locationText && (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">{locationText}</p>
      )}

      {visibleLinks.length > 0 && (
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

      {organisation.run_by_text && (
        <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
          <span className="font-semibold">Run by: </span>
          {organisation.run_by_text}
        </p>
      )}

      {/* People. Only artists who are themselves approved appear here —
          the two-sided RLS policy on artist_organisations enforces it — so
          an organisation can legitimately look emptier than it is while
          its artists are still being reviewed. */}
      {roleGroups.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 text-lg font-semibold">Artists</h2>
          <div className="flex flex-col gap-1 text-sm text-gray-600 dark:text-gray-400">
            {roleGroups.map(({ role, items }) => (
              <p key={role.key}>
                <span className="font-semibold">{roleHeading(role, "artists")}: </span>
                {items.map((entry, i) => (
                  <span key={`${entry.artist.id}-${role.key}`}>
                    {i > 0 && ", "}
                    <Link
                      href={`/artist/${entry.artist.id}`}
                      className="text-violet-600 hover:underline dark:text-violet-400"
                    >
                      {entry.artist.name}
                    </Link>
                  </span>
                ))}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
