import type { Metadata } from "next";
import Script from "next/script";
import Link from "next/link";
import { Space_Grotesk, Space_Mono, Inter } from "next/font/google";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./auth-actions";
import HeaderSearch from "@/components/HeaderSearch";
import ThemeToggle from "@/components/ThemeToggle";
import SmokeBackdrop from "@/components/SmokeBackdrop";
import "./globals.css";

// Self-hosted at build time by next/font — no runtime network request.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-display",
  display: "swap",
});
const mono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
  display: "swap",
});
const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

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
    <html
      lang="en"
      className={`h-full antialiased dark ${display.variable} ${mono.variable} ${body.variable}`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-gray-950">
        <Script
          id="theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
        <SmokeBackdrop />
        <header className="sticky top-0 z-20 border-b border-gray-200 bg-white dark:border-white/10 dark:bg-[#0a0910]/70 dark:backdrop-blur-lg">
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
              <Link
                href="/"
                className="ff-display flex shrink-0 items-center gap-2.5 text-lg font-semibold"
              >
                <span className="eq" aria-hidden="true">
                  <i></i>
                  <i></i>
                  <i></i>
                  <i></i>
                </span>
                Rebalance Gender
              </Link>
              <div className="hidden sm:block">
                <HeaderSearch />
              </div>
              <nav className="flex items-center gap-4 text-sm">
                <Link href="/" className="hover:underline">
                  Directory
                </Link>
                <a href="/submit" className="hover:underline">
                  Submit an artist
                </a>
                <ThemeToggle />
              </nav>
            </div>
          </div>
        </header>
        <main className="relative z-10 flex-1">{children}</main>
      </body>
    </html>
  );
}
