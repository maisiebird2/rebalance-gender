import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./auth-actions";
import HeaderSearch from "@/components/HeaderSearch";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rebalance Gender",
  description:
    "A directory of women and gender-expansive producers and DJs in electronic music.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-black">
        <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="mx-auto max-w-6xl px-4">
            {/* Admin row — only rendered when signed in, takes no space otherwise */}
            {user && (
              <div className="flex items-center justify-end gap-4 border-b border-gray-100 py-1.5 text-sm dark:border-gray-800">
                <a
                  href="/admin"
                  className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                >
                  Admin panel
                </a>
                <form action={signOut}>
                  <button
                    type="submit"
                    className="text-gray-500 hover:underline dark:text-gray-400"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            )}

            {/* Main ribbon */}
            <div className="flex items-center justify-between gap-4 py-4">
              <a href="/" className="shrink-0 text-lg font-semibold">
                Rebalance Gender
              </a>
              <div className="hidden sm:block">
                <HeaderSearch />
              </div>
              <nav className="flex gap-4 text-sm">
                <a href="/" className="hover:underline">
                  Directory
                </a>
                <a href="/submit" className="hover:underline">
                  Submit an artist
                </a>
              </nav>
            </div>
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
