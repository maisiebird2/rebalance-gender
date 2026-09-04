import type { Metadata } from "next";
import Link from "next/link";
import { Space_Grotesk, Space_Mono, Inter } from "next/font/google";
import { getViewer } from "@/lib/admin-auth";
import { signOut } from "./auth-actions";
import HeaderSearch from "@/components/HeaderSearch";
import SmokeBackdrop from "@/components/SmokeBackdrop";
import { siteUrl } from "@/lib/site-url";
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

const SITE_URL = siteUrl();
const DESCRIPTION =
  "A directory of women and gender-expansive producers and DJs in electronic music.";

export const metadata: Metadata = {
  // Makes the file-based opengraph-image / twitter-image / icon URLs absolute.
  metadataBase: new URL(SITE_URL),
  // Every page supplies only its own part ("About", the artist's name); the
  // suffix lives here and nowhere else.
  title: { default: "All Frequencies", template: "%s | All Frequencies" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "All Frequencies",
    title: "All Frequencies",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "All Frequencies",
    description: DESCRIPTION,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { user, isAdmin } = await getViewer();

  return (
    <html
      lang="en"
      className={`h-full antialiased dark ${display.variable} ${mono.variable} ${body.variable}`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-gray-950">
        <SmokeBackdrop />
        <header className="club-header sticky top-0 z-20 border-b border-gray-200 bg-white dark:border-white/10 dark:bg-[#0a0910]/70 dark:backdrop-blur-lg">
          <div className="relative z-10 mx-auto max-w-6xl px-4">
            {/* Admin row — only rendered when signed in, takes no space otherwise */}
            {user && (
              <div className="flex items-center justify-end gap-4 border-b border-gray-100 py-1.5 text-sm dark:border-gray-800">
                {isAdmin && (
                  <a
                    href="/admin"
                    className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                  >
                    Admin panel
                  </a>
                )}
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
                aria-label="All Frequencies — home"
                className="logo-link flex shrink-0 items-center gap-2.5"
              >
                <svg
                  className="spectrum-mark shrink-0"
                  viewBox="0 0 32 32"
                  width="28"
                  height="28"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient
                      id="spectrum-grad"
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1="32"
                      x2="0"
                      y2="0"
                    >
                      <stop offset="0" stopColor="#6a4dff" />
                      <stop offset="1" stopColor="#ff2d9b" />
                    </linearGradient>
                  </defs>
                  <rect className="b1" x="0" y="19" width="4" height="13" rx="2" fill="url(#spectrum-grad)" />
                  <rect className="b2" x="7" y="10" width="4" height="22" rx="2" fill="url(#spectrum-grad)" />
                  <rect className="b3" x="14" y="0" width="4" height="32" rx="2" fill="url(#spectrum-grad)" />
                  <rect className="b4" x="21" y="12" width="4" height="20" rx="2" fill="url(#spectrum-grad)" />
                  <rect className="b5" x="28" y="17" width="4" height="15" rx="2" fill="url(#spectrum-grad)" />
                </svg>
                <span className="flex flex-col text-[19px] font-bold leading-[0.96] tracking-tight">
                  <span>All</span>
                  <span className="grad-text">Frequencies</span>
                </span>
              </Link>
              <div className="hidden items-center gap-2 sm:flex">
                <HeaderSearch />
              </div>
              <nav className="flex items-center gap-4 text-sm">
                <a href="/submit" className="hover:underline">
                  Submit an artist
                </a>
                <Link href="/about" className="hover:underline">
                  About
                </Link>
              </nav>
            </div>
          </div>
        </header>
        <main className="relative z-10 flex-1">{children}</main>
      </body>
    </html>
  );
}
