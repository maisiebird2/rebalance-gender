import Link from "next/link";

interface Props {
  artistId: string;
}

// Rendered only for admins (the artist page gates on getViewer().isAdmin);
// the edit page and its actions enforce the same check server-side.
export default function EditButton({ artistId }: Props) {
  return (
    <Link
      href={`/artist/${artistId}/edit`}
      className="rounded-md border border-violet-400 px-3 py-1 text-sm font-medium text-violet-600 hover:bg-violet-50 dark:border-violet-500 dark:text-violet-400 dark:hover:bg-violet-900/20"
    >
      Edit
    </Link>
  );
}
