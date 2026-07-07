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
  "Rebalance Gender is a directory of women and gender-expansive producers and DJs in electronic music.";

export default async function AboutPage() {
  const content = (await getSiteContent("about")) ?? FALLBACK;

  // Blank lines separate paragraphs; single newlines become line breaks.
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">
        <span className="grad-text">About</span>
      </h1>
      <div className="flex flex-col gap-4 text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
        {paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-line">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}
