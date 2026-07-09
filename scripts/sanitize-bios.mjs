#!/usr/bin/env node
// ============================================================
// Bio sanitization script.
//
// Reads every row in artist_enrichment that has a bio, runs the
// bio through sanitize-html (pure Node.js, no DOM required),
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
// Uses sanitize-html, which is already a project dependency (npm install).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import sanitizeHtml from "sanitize-html";
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
// sanitize-html config
// NOTE: keep this logic in sync with src/lib/sanitize-bio.ts,
// which is the version used by the saveArtist server action.
// (Both use sanitize-html — pure Node.js, no DOM required.)
// ------------------------------------------------------------

/**
 * Convert a raw bio string to safe, renderable HTML.
 *
 * Steps:
 *  1. Detect whether the bio already contains HTML markup. If not,
 *     convert bare newlines to <br> so line breaks are preserved
 *     when rendered as HTML.
 *  2. Run through sanitize-html to strip any unsafe tags/attributes.
 *  3. Add target="_blank" + rel="noopener noreferrer" to every <a>
 *     tag (prevents tab-napping and referrer leakage to external sites).
 */
function sanitizeBio(raw) {
  // Simple heuristic: if the string contains any HTML tag, treat it
  // as HTML and sanitize directly. Otherwise convert newlines first.
  const trimmed = raw.trim();
  const hasHtml = /<[a-z][\s\S]*?>/i.test(trimmed);
  const html = hasHtml ? trimmed : trimmed.replace(/\n/g, "<br>");

  return sanitizeHtml(html, {
    allowedTags: ["a", "br", "p", "strong", "em", "b", "i", "ul", "ol", "li"],
    allowedAttributes: {
      a: ["href", "target", "rel"],
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
    },
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

  // Fetch matching enrichment rows using keyset pagination on the `id`
  // primary key. This is much faster than OFFSET-style .range() (which
  // re-scans skipped rows on every page and eventually hits Supabase's
  // statement timeout), and it lets --limit cap the query itself instead
  // of fetching the whole table and trimming afterward.
  const PAGE_SIZE = 1000;
  const rows = [];
  let lastId = 0;
  while (true) {
    // When --limit is set, never request more than we still need.
    const pageSize = LIMIT ? Math.min(PAGE_SIZE, LIMIT - rows.length) : PAGE_SIZE;
    if (pageSize <= 0) break;

    let q = supabase
      .from("artist_enrichment")
      .select("id, artist_id, platform, bio, bio_sanitized")
      .not("bio", "is", null)
      .gt("id", lastId)
      .order("id")
      .limit(pageSize);

    if (!FORCE) q = q.is("bio_sanitized", null);
    if (PLATFORM_FILTER) q = q.eq("platform", PLATFORM_FILTER);

    const { data, error } = await q;
    if (error) {
      console.error("Failed to fetch rows:", error.message);
      process.exit(1);
    }
    rows.push(...data);
    if (data.length < pageSize) break;
    lastId = data[data.length - 1].id;
  }

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
