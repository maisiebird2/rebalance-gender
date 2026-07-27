// ============================================================
// Pure parser for a HÖR /artist/<slug>/ page, shared by enrich-hoer-terms.mjs
// (Phase C). Regex-based (no DOM in Node), same convention as sync-bandcamp.mjs;
// the selectors are the ones verified against the server-rendered HTML in
// sync-hoer.mjs (2026-07-10). DB-free and deterministic → unit-tested
// (hoer-page.test.mjs).
//
// Phase C only WRITES two of these fields (imageUrl, socials); the rest
// (stageName, wpUserId, location) ride along into the api_response_cache blob
// for later mining. Name/bio/legal name all come from the posts feed now, so
// this page is no longer the source for them.
// ============================================================

import { decodeEntities } from "./hoer-library.mjs";

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

function firstMatch(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

// WordPress serves resized derivatives like Name-1024x1024.jpeg; strip a
// trailing -WxH so we store the original (the un-suffixed file always exists).
// '-scaled' is left intact (that IS the stored large original).
export function largestImageUrl(url) {
  return url.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "");
}

// Parse a /artist/<slug>/ page. Any field may legitimately be absent (e.g. many
// artists have no portrait → no .artist__image div). Returns
// { stageName, wpUserId, imageUrl, socials, location }.
export function parseArtistPage(html) {
  const stageNameRaw = firstMatch(
    html,
    /<h1\b[^>]*class="[^"]*\bartist__title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i
  );
  const stageName = stageNameRaw ? htmlToText(stageNameRaw).trim() : null;

  // WordPress user id from the <body> class (`author-<id>`). Kept for the blob;
  // the bio it used to key is now taken from the posts feed. The trailing \b
  // keeps \d+ from matching a leading digit of `author-<slug>` (e.g.
  // author-2hot2play).
  const wpUserId = firstMatch(html, /<body\b[^>]*\bclass="[^"]*\bauthor-(\d+)\b[^"]*"/i);

  // Portrait: an .artist__image div with inline background-image (class and
  // style can appear in either order). Absent div = no portrait.
  let imageUrl = null;
  const imgBlock =
    firstMatch(html, /<div\b[^>]*\bartist__image\b[^>]*style="([^"]*)"/i) ||
    firstMatch(html, /style="([^"]*background-image[^"]*)"[^>]*\bartist__image\b/i);
  if (imgBlock) {
    const um = imgBlock.match(/background-image:\s*url\((['"]?)([^)'"]+)\1\)/i);
    if (um) imageUrl = largestImageUrl(decodeEntities(um[2]));
  }

  // Socials: anchors inside .artist__socials. The page has TWO such blocks: a
  // JS-template placeholder (all href="") FIRST, then the real server-rendered
  // block. Scan ALL blocks, keep non-empty hrefs (the placeholder's empties
  // never match), dedupe across blocks. Taking only the first block → 0 socials.
  const socials = [];
  const seenSocial = new Set();
  const socialsBlockRe =
    /<div\b[^>]*class="[^"]*\bartist__socials\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let socialsBlock;
  while ((socialsBlock = socialsBlockRe.exec(html)) !== null) {
    const re = /href="([^"]+)"/gi;
    let m;
    while ((m = re.exec(socialsBlock[1])) !== null) {
      const href = decodeEntities(m[1]);
      if (!href.trim() || seenSocial.has(href)) continue;
      seenSocial.add(href);
      socials.push(href);
    }
  }

  // Location: best-effort only (rendered as a generic .btn with no stable hook).
  const locRaw = firstMatch(
    html,
    /<[^>]*class="[^"]*\bartist__location\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i
  );
  const location = locRaw ? htmlToText(locRaw) || null : null;

  return { stageName, wpUserId, imageUrl, socials, location };
}
