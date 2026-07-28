// Shown to signed-in non-admin users who navigate to an /admin page.
// Anonymous visitors never reach this — the pages redirect them to /login.
export default function NotAdminNotice() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16 text-center text-sm text-gray-600 dark:text-gray-400">
      This page is only available to admins.
    </div>
  );
}
