import type { Metadata } from "next";
import Script from "next/script";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./auth-actions";
import HeaderSearch from "@/components/HeaderSearch";
import ThemeToggle from "@/components/ThemeToggle";
import "./globals.css";

// Runs before paint to apply any saved theme preference. Midnight violet
// (dark) is the default when nothing has been saved yet, so the
// server-rendered `dark` class on <html> below is left in place unless
// this finds an explicit "light" choice in localStorage.
const themeBootstrapScript = `
(function () {
  try {
    var stored = localStorage.getItem("theme");
    if (stored === "light") {
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }
  } catch (e) {}
})();
`;

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
    <html lang="en" className="h-full antialiased dark">
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-gray-950">
        <Script
          id="theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
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
              <nav className="flex items-center gap-4 text-sm">
                <a href="/" className="hover:underline">
                  Directory
                </a>
                <a href="/submit" className="hover:underline">
                  Submit an artist
                </a>
                <ThemeToggle />
              </nav>
            </div>
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
