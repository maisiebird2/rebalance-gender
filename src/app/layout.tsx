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
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
            <a href="/" className="shrink-0 text-lg font-semibold">
              Rebalance Gender
            </a>
            <HeaderSearch />
            <nav className="flex gap-4 text-sm">
              <a href="/" className="hover:underline">
                Directory
              </a>
              <a href="/submit" className="hover:underline">
                Submit an artist
              </a>
              {user && (
                <a
                  href="/admin"
                  className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                >
                  Admin panel
                </a>
              )}
              {user && (
                <form action={signOut}>
                  <button
                    type="submit"
                    className="text-gray-500 hover:underline dark:text-gray-400"
                  >
                    Sign out
                  </button>
                </form>
              )}
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
