#!/usr/bin/env node
// ============================================================
// Bio linkification script.
//
// Post-processes the bio_sanitized column in artist_enrichment:
//
//   1. Converts bare URLs (https://...) that aren't already inside
//      an <a> tag into clickable links.
//
//   2. Converts @mentions into SoundCloud profile links.
//      e.g. "ONE HALF OF @GREAZUS" becomes
//           "ONE HALF OF <a href="https://soundcloud.com/greazus">GREAZUS</a>"
//
//      @mention rules:
//        - Only triggers when @ is at the start of the bio, or is
//          preceded by a space or line break — so email addresses
//          like artist@gmail.com are left untouched.
//        - Username is lowercased in the URL; display text preserves
//          the original casing (minus the @).
//
// This script is meant to run after sanitize-bios.mjs. It updates
// bio_sanitized in place.
//
// Idempotent: already-linked text won't be double-processed. Text
// nodes that are inside an existing <a> tag are skipped entirely.
// The script also skips rows where bio_sanitized didn't change.
//
// Usage (from the wem-directory/ folder):
//
//   npm run linkify-bios                      # process all rows with bio_sanitized
//   npm run linkify-bios -- --limit=20        # only process the first 20
//   npm run linkify-bios -- --platform=soundcloud
//   npm run linkify-bios -- --name="nina kraviz"
//   DRY_RUN=1 npm run linkify-bios           # log without writing to DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const platformArg = args.find((a) => a.startsWith("--platform="));
const PLATFORM_FILTER = platformArg ? platformArg.slice("--platform=".length) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length).toLowerCase() : null;

// ------------------------------------------------------------
// Load .env.local
// ------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY);

// ------------------------------------------------------------
// Linkification logic
// NOTE: keep this logic in sync with src/lib/sanitize-bio.ts,
// which is the version used by the saveArtist server action.
// ------------------------------------------------------------

/**
 * Process a plain-text segment (i.e. text that is NOT inside an HTML
 * tag). Replaces @mentions and bare URLs with <a> tags.
 *
 * The combined regex processes left-to-right so the first match wins,
 * preventing any overlap between the two patterns.
 */
function transformTextSegment(text) {
  return text.replace(
    // @mention: @ must be at the start of the string, or preceded by
    // whitespace. Excludes email addresses (e.g. artist@gmail.com).
    //
    // https?:// URL: standard absolute URLs.
    //
    // www. URL: bare www. domains not already preceded by :// (so
    // https://www.domain.com is caught by the https? branch first).
    // Must be at start or after whitespace. https:// is prepended to
    // the href automatically.
    /((?:^|(?<=\s))@([A-Za-z0-9_-]+))|(https?:\/\/[^\s<>"']+)|((?:^|(?<=\s))www\.[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}[^\s<>"']*)/g,
    (_match, atMatch, username, httpsUrl, wwwUrl) => {
      if (atMatch) {
        const slug = username.toLowerCase();
        return `<a href="https://soundcloud.com/${slug}" target="_blank" rel="noopener noreferrer">${username}</a>`;
      } else {
        const raw = httpsUrl ?? wwwUrl;
        const href = wwwUrl ? `https://${raw}` : raw;
        // Strip trailing punctuation that's likely not part of the URL.
        const cleanedHref = href.replace(/[.,;:!?)\]}'">]+$/, "");
        const cleanedRaw = raw.slice(0, raw.length - (href.length - cleanedHref.length));
        const trailing = raw.slice(cleanedRaw.length);
        return `<a href="${cleanedHref}" target="_blank" rel="noopener noreferrer">${cleanedRaw}</a>${trailing}`;
      }
    }
  );
}

/**
 * Walk the HTML string segment by segment, processing only text nodes
 * that are NOT inside an <a> tag. Skips content inside <a>...</a> to
 * avoid double-linking (making the function idempotent on re-runs).
 */
function linkifyBio(html) {
  // Split into alternating [text, tag, text, tag, ...] segments.
  // Captured groups (the parentheses) mean the tag strings are included.
  const parts = html.split(/(<[^>]+>)/);

  let insideAnchor = 0;
  return parts
    .map((segment) => {
      if (segment.startsWith("<")) {
        // It's an HTML tag — update anchor-depth tracking but don't transform.
        if (/^<a[\s>]/i.test(segment)) insideAnchor++;
        else if (/^<\/a\s*>/i.test(segment)) insideAnchor = Math.max(0, insideAnchor - 1);
        return segment;
      }
      // It's a text node — only transform if we're not inside an <a>.
      return insideAnchor > 0 ? segment : transformTextSegment(segment);
    })
    .join("");
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    `linkify-bios: starting${DRY_RUN ? " (DRY RUN — no DB writes)" : ""}` +
      `${PLATFORM_FILTER ? `, --platform=${PLATFORM_FILTER}` : ""}` +
      `${NAME_FILTER ? `, --name=${NAME_FILTER}` : ""}` +
      `${LIMIT ? `, --limit=${LIMIT}` : ""}`
  );

  // Resolve --name filter to artist IDs up front
  let nameFilterIds = null;
  if (NAME_FILTER) {
    const { data: matched, error: nameErr } = await supabase
      .from("artists")
      .select("id")
      .ilike("name", `%${NAME_FILTER}%`);
    if (nameErr) {
      console.error("Failed to look up artists by name:", nameErr.message);
      process.exit(1);
    }
    nameFilterIds = (matched ?? []).map((a) => a.id);
    console.log(`  Name filter "${NAME_FILTER}": ${nameFilterIds.length} artist(s) matched.`);
    if (!nameFilterIds.length) {
      console.log("  No matches — nothing to do.");
      return;
    }
  }

  // Fetch all matching enrichment rows, paginating past Supabase's 1000-row limit.
  const PAGE_SIZE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from("artist_enrichment")
      .select("id, platform, bio_sanitized")
      .not("bio_sanitized", "is", null)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if (PLATFORM_FILTER) q = q.eq("platform", PLATFORM_FILTER);
    if (nameFilterIds) q = q.in("artist_id", nameFilterIds);

    const { data, error } = await q;
    if (error) {
      console.error("Failed to fetch rows:", error.message);
      process.exit(1);
    }
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (LIMIT) rows.splice(LIMIT);

  if (!rows.length) {
    console.log("No rows to process.");
    return;
  }

  console.log(`Processing ${rows.length} row(s)…`);

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    const linkified = linkifyBio(row.bio_sanitized.trim());

    // Skip the DB write if nothing changed (keeps the script idempotent
    // and avoids unnecessary updated_at bumps).
    if (linkified === row.bio_sanitized) {
      unchanged++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`\n[DRY RUN] id=${row.id} platform=${row.platform}`);
      console.log("  BEFORE:", row.bio_sanitized.slice(0, 120));
      console.log("  AFTER: ", linkified.slice(0, 120));
      updated++;
      continue;
    }

    const { error: updateError } = await supabase
      .from("artist_enrichment")
      .update({ bio_sanitized: linkified })
      .eq("id", row.id);

    if (updateError) {
      console.error(`  ✗ id=${row.id} (${row.platform}): ${updateError.message}`);
      failed++;
    } else {
      updated++;
      if (updated % 50 === 0) {
        console.log(`  … ${updated} updated so far`);
      }
    }
  }

  console.log(
    `\nDone. ${updated} updated, ${unchanged} unchanged, ${failed} failed.`
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
