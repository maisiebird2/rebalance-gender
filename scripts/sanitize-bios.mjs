#!/usr/bin/env node
// ============================================================
// Bio sanitization script.
//
// Reads every row in artist_enrichment that has a bio, runs the
// bio through DOMPurify (server-side via isomorphic-dompurify),
// and writes the sanitized HTML to bio_sanitized.
//
// Why a separate column rather than overwriting bio:
//   - bio preserves the original raw text from the source (e.g.
//     SoundCloud), which is useful for debugging or re-processing.
//   - bio_sanitized is what the artist page renders via
//     dangerouslySetInnerHTML. It is safe to render as HTML.
//
// What sanitization does:
//   - Strips <script>, <iframe>, and all event handlers (onerror,
//     onmouseover, etc.).
//   - Strips javascript: and data: URLs from href attributes.
//   - Keeps safe formatting: <a>, <br>, <p>, <strong>, <em>,
//     <b>, <i>, <ul>, <ol>, <li>.
//   - Converts bare newlines to <br> before sanitizing, so plain-
//     text bios (no HTML markup) still display with correct line
//     breaks when rendered as HTML.
//   - Adds rel="noopener noreferrer" to every <a> tag so outbound
//     links don't expose the referrer or allow tab-napping.
//
// Usage (from the rebalance-gender/ folder):
//
//   npm run sanitize-bios                      # process all un-sanitized bios
//   npm run sanitize-bios -- --force           # re-sanitize even rows that already have bio_sanitized
//   npm run sanitize-bios -- --limit=20        # only process the first 20 rows (for testing)
//   npm run sanitize-bios -- --platform=soundcloud  # only process one platform
//   DRY_RUN=1 npm run sanitize-bios           # log what would be written, but don't update the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// Run `npm install` first to ensure isomorphic-dompurify is installed.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import DOMPurify from "isomorphic-dompurify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const platformArg = args.find((a) => a.startsWith("--platform="));
const PLATFORM_FILTER = platformArg ? platformArg.slice("--platform=".length) : null;

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
// DOMPurify config
// NOTE: keep this logic in sync with src/lib/sanitize-bio.ts,
// which is the version used by the saveArtist server action.
// ------------------------------------------------------------

// Tags we want to preserve from the source HTML.
const ALLOWED_TAGS = ["a", "br", "p", "strong", "em", "b", "i", "ul", "ol", "li"];

// Attributes we allow on those tags.
// `target` is not in DOMPurify's default set so we add it explicitly.
const ALLOWED_ATTR = ["href", "target", "rel"];

// After sanitization, add rel="noopener noreferrer" to every <a> tag.
// This prevents tab-napping (window.opener access) and stops the
// referrer header from leaking to external sites.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * Convert a raw bio string to safe, renderable HTML.
 *
 * Steps:
 *  1. Detect whether the bio already contains HTML markup. If not,
 *     convert bare newlines to <br> so line breaks are preserved
 *     when rendered as HTML.
 *  2. Run through DOMPurify to strip any unsafe tags/attributes.
 */
function sanitizeBio(raw) {
  // Simple heuristic: if the string contains any HTML tag, treat it
  // as HTML and sanitize directly. Otherwise convert newlines first.
  const hasHtml = /<[a-z][\s\S]*?>/i.test(raw);

  const html = hasHtml
    ? raw
    : raw.replace(/\n/g, "<br>");

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(
    `sanitize-bios: starting${DRY_RUN ? " (DRY RUN — no DB writes)" : ""}` +
      `${FORCE ? ", --force (re-sanitizing all)" : ""}` +
      `${PLATFORM_FILTER ? `, --platform=${PLATFORM_FILTER}` : ""}` +
      `${LIMIT ? `, --limit=${LIMIT}` : ""}`
  );

  // Fetch all matching enrichment rows, paginating past Supabase's 1000-row limit.
  const PAGE_SIZE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from("artist_enrichment")
      .select("id, artist_id, platform, bio, bio_sanitized")
      .not("bio", "is", null)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if (!FORCE) q = q.is("bio_sanitized", null);
    if (PLATFORM_FILTER) q = q.eq("platform", PLATFORM_FILTER);

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
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const sanitized = sanitizeBio(row.bio);

    if (DRY_RUN) {
      console.log(`\n[DRY RUN] id=${row.id} platform=${row.platform}`);
      console.log("  RAW:", row.bio.slice(0, 120).replace(/\n/g, "↵"));
      console.log("  OUT:", sanitized.slice(0, 120));
      updated++;
      continue;
    }

    const { error: updateError } = await supabase
      .from("artist_enrichment")
      .update({ bio_sanitized: sanitized })
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
    `\nDone. ${updated} updated, ${skipped} skipped, ${failed} failed.`
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
