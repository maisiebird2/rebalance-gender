// ============================================================
// Shared helper for finding/removing Linktree links from scraped
// bio text (used by both enrich-bios.mjs and clean-linktree-bios.mjs).
// ============================================================

// Matches linktr.ee URLs with or without a scheme/"www." prefix, e.g.
//   https://linktr.ee/boticka_music
//   linktr.ee/boticka_music
const LINKTREE_URL_REGEX = /(?:https?:\/\/)?(?:www\.)?linktr\.ee\/[^\s)]+/i;

// Lines that, once the URL itself is stripped out, are just the word
// "Linktree" (optionally with an emoji, colon, or dash around it) —
// e.g. "Linktree:", "🔗 Linktree", "- Linktree -".
const LINKTREE_LABEL_ONLY_REGEX = /^[^\w]*linktree[^\w]*$/i;

/**
 * Find the first Linktree URL in `text`, strip it (and any leftover
 * "Linktree" label text) out of the bio, and return the cleaned text
 * plus the extracted URL.
 *
 * Returns `{ text, linktreeUrl: null }` unchanged if no Linktree URL
 * is found.
 */
export function extractLinktree(text) {
  const match = text.match(LINKTREE_URL_REGEX);
  if (!match) return { text, linktreeUrl: null };

  let linktreeUrl = match[0].replace(/[.,;:!?)]+$/, "");
  if (!/^https?:\/\//i.test(linktreeUrl)) {
    linktreeUrl = `https://${linktreeUrl.replace(/^www\./i, "")}`;
  }

  const cleanedLines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = rawLine.replace(match[0], "").trim();
    if (!stripped) continue;
    if (LINKTREE_LABEL_ONLY_REGEX.test(stripped)) continue;
    cleanedLines.push(stripped);
  }

  return { text: cleanedLines.join("\n").trim(), linktreeUrl };
}
