import Link from "next/link";

interface PaginationProps {
  currentPage: number;
  /** Whether a page exists after the current one. */
  hasMore: boolean;
  /** Current search params, used to build links that preserve filters. */
  searchParams: { [key: string]: string | string[] | undefined };
  /** Path the page links point at. Defaults to the homepage. */
  basePath?: string;
}

function pageHref(
  page: number,
  searchParams: PaginationProps["searchParams"],
  basePath: string
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) params.set(key, value);
  }
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export default function Pagination({
  currentPage,
  hasMore,
  searchParams,
  basePath = "/",
}: PaginationProps) {
  if (currentPage <= 1 && !hasMore) return null;

  const prevDisabled = currentPage <= 1;
  const nextDisabled = !hasMore;

  const linkClass =
    "rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900";
  const disabledClass =
    "rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-600";

  return (
    <nav
      aria-label="Pagination"
      className="mt-8 flex items-center justify-center gap-3"
    >
      {prevDisabled ? (
        <span className={disabledClass}>← Previous</span>
      ) : (
        <Link href={pageHref(currentPage - 1, searchParams, basePath)} className={linkClass}>
          ← Previous
        </Link>
      )}

      <span className="text-sm text-gray-600 dark:text-gray-400">
        Page {currentPage}
      </span>

      {nextDisabled ? (
        <span className={disabledClass}>Next →</span>
      ) : (
        <Link href={pageHref(currentPage + 1, searchParams, basePath)} className={linkClass}>
          Next →
        </Link>
      )}
    </nav>
  );
}
