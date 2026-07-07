import type { Metadata } from "next";
import { getSiteContent } from "@/lib/queries";

export const metadata: Metadata = {
  title: "About · Rebalance Gender",
  description:
    "About Rebalance Gender — a directory of women and gender-expansive producers and DJs in electronic music.",
};

// Re-read on each request so edits from the admin panel show up promptly.
export const dynamic = "force-dynamic";

const FALLBACK =
  "<p>Rebalance Gender is a directory of women and gender-expansive producers and DJs in electronic music.</p>";

export default async function AboutPage() {
  // Content is admin-authored (only authenticated admins can write it), so
  // it's trusted and rendered as HTML. The .about-content styles in
  // globals.css give paragraphs, links, and lists sensible spacing.
  const content = (await getSiteContent("about")) ?? FALLBACK;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">
        <span className="grad-text">About</span>
      </h1>
      <div
        className="about-content text-[15px] leading-relaxed text-gray-700 dark:text-gray-300"
        dangerouslySetInnerHTML={{ __html: content }}
      />
    </div>
  );
}
