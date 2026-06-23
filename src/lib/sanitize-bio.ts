/**
 * Bio sanitization and linkification utilities.
 *
 * Used both by the saveArtist server action (on manual bio edits) and
 * by the standalone scripts/sanitize-bios.mjs + scripts/linkify-bios.mjs
 * (for bulk processing of enrichment data).
 *
 * NOTE: isomorphic-dompurify uses jsdom under the hood in Node.js
 * environments, so this module must only be imported in server-side
 * code (Server Actions, API routes, scripts). Never import it in a
 * Client Component.
 */

import DOMPurify from "isomorphic-dompurify";

// ------------------------------------------------------------
// DOMPurify config
// ------------------------------------------------------------

const ALLOWED_TAGS = ["a", "br", "p", "strong", "em", "b", "i", "ul", "ol", "li"];
const ALLOWED_ATTR = ["href", "target", "rel"];

// Add rel="noopener noreferrer" and target="_blank" to every <a> after
// sanitization, so outbound links don't expose the referrer or allow
// tab-napping.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Sanitize a raw bio string with DOMPurify.
 *
 * If the bio contains no HTML markup, bare newlines are converted to
 * <br> first so line breaks are preserved when rendered as HTML.
 * Returns a safe HTML string suitable for dangerouslySetInnerHTML.
 */
export function sanitizeBio(raw: string): string {
  const trimmed = raw.trim();
  const hasHtml = /<[a-z][\s\S]*?>/i.test(trimmed);
  const html = hasHtml ? trimmed : trimmed.replace(/\n/g, "<br>");
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}

// ------------------------------------------------------------
// Linkification
// ------------------------------------------------------------

/**
 * Process a plain-text segment (i.e. content that is NOT inside an
 * HTML tag). Converts bare URLs and @mentions to <a> links.
 *
 * @mention rules:
 *   - Only matches when @ is at the start of the segment or preceded
 *     by whitespace — so email addresses (artist@gmail.com) are left
 *     untouched.
 *   - Username is lowercased in the SoundCloud URL; display text
 *     preserves original casing (minus the @).
 *
 * www. URL rules:
 *   - Matches bare www. domains (e.g. www.freshhex.com) not already
 *     preceded by :// (so https://www.domain.com is handled by the
 *     https? branch instead). Must be at the start or after whitespace.
 *   - https:// is prepended to the href automatically.
 */
function transformTextSegment(text: string): string {
  return text.replace(
    /((?:^|(?<=\s))@([A-Za-z0-9_-]+))|(https?:\/\/[^\s<>"']+)|((?:^|(?<=\s))www\.[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}[^\s<>"']*)/g,
    (_match, atMatch, username, httpsUrl, wwwUrl) => {
      if (atMatch) {
        const slug = username.toLowerCase();
        return `<a href="https://soundcloud.com/${slug}" target="_blank" rel="noopener noreferrer">${username}</a>`;
      } else {
        // Both https?:// and bare www. URLs share the same link-building logic.
        const raw = httpsUrl ?? wwwUrl;
        const href = wwwUrl ? `https://${raw}` : raw;
        // Strip trailing punctuation unlikely to be part of the URL.
        const cleanedHref = href.replace(/[.,;:!?)\]}'">]+$/, "");
        const cleanedRaw = raw.slice(0, raw.length - (href.length - cleanedHref.length));
        const trailing = raw.slice(cleanedRaw.length);
        return `<a href="${cleanedHref}" target="_blank" rel="noopener noreferrer">${cleanedRaw}</a>${trailing}`;
      }
    }
  );
}

/**
 * Walk the HTML string segment by segment, transforming only text
 * nodes that are NOT inside an existing <a> tag. This makes the
 * function idempotent — running it twice produces the same result.
 */
export function linkifyBio(html: string): string {
  const parts = html.split(/(<[^>]+>)/);
  let insideAnchor = 0;

  return parts
    .map((segment) => {
      if (segment.startsWith("<")) {
        if (/^<a[\s>]/i.test(segment)) insideAnchor++;
        else if (/^<\/a\s*>/i.test(segment)) insideAnchor = Math.max(0, insideAnchor - 1);
        return segment;
      }
      return insideAnchor > 0 ? segment : transformTextSegment(segment);
    })
    .join("");
}

/**
 * Convenience: sanitize then linkify in one call.
 * This is the function to use when saving a manually edited bio.
 */
export function sanitizeAndLinkifyBio(raw: string): string {
  return linkifyBio(sanitizeBio(raw));
}
