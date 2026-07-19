#!/usr/bin/env node
// ============================================================
// Export a link-backfill candidate set as an ODS spreadsheet
//
// Finds approved artists who HAVE a link on one platform but are
// MISSING one on another, and writes them to an .ods file for manual
// research: open the sheet, follow the "have" link, and fill in the
// URLs you find. The result is meant to be read back in later and
// upserted into artist_links.
//
// The default pair (resident_advisor → soundcloud) exists because RA
// artist pages usually list a SoundCloud, but RA cannot be harvested
// automatically — see the Resident Advisor section in PIPELINE.md.
// Hence: a hand-filled sheet rather than a scraper.
//
// "MISSING" follows the same rule as the admin Missing-links page (see
// getArtistsMissingLink() in src/lib/queries.ts): an artist with a
// not_found row for the platform is NOT missing — someone already
// searched and concluded they aren't on it. Such artists are skipped.
// Conversely the "have" link must be live (not_found = false), since a
// dead link is no use as a research starting point.
//
// Only approved, non-deleted artists are included — /artist/<id> 404s
// for anything else, which would make the sheet's name hyperlinks dead.
//
// Every platform gets a column, PRE-FILLED with any URL already stored.
// Do not clear a pre-filled cell to mean "no change" — blank means "no
// link stored", which is exactly what the upsert step will look for.
//
// This script is read-only against the database.
//
// Usage (from rebalance-gender/):
//
//   node scripts/export-link-backfill-candidates.mjs
//   node scripts/export-link-backfill-candidates.mjs --have=resident_advisor --missing=soundcloud
//   node scripts/export-link-backfill-candidates.mjs --have=hoer --missing=bandcamp
//   node scripts/export-link-backfill-candidates.mjs --out=.cache/my-sheet.ods
//   node scripts/export-link-backfill-candidates.mjs --limit=20
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
// and NEXT_PUBLIC_SITE_URL for the artist-page hyperlinks).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const HAVE = argValue("have", "resident_advisor");
const MISSING = argValue("missing", "soundcloud");
const limitArg = argValue("limit", null);
const LIMIT = limitArg ? parseInt(limitArg, 10) : null;
const OUT = argValue("out", path.join(".cache", `backfill-${HAVE}-missing-${MISSING}.ods`));

// ── Load .env.local ─────────────────────────────────────────
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
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.rebalance-gender.app").replace(/\/+$/, "");

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY);

// ── XML helpers ─────────────────────────────────────────────
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A cell whose text is a clickable hyperlink. */
function linkCell(text, href) {
  return (
    `<table:table-cell table:style-name="ceBody" office:value-type="string">` +
    `<text:p><text:a xlink:type="simple" xlink:href="${xmlEscape(href)}">${xmlEscape(text)}</text:a></text:p>` +
    `</table:table-cell>`
  );
}

/** A plain string cell; empty/nullish values produce a truly empty cell. */
function textCell(text, styleName = "ceBody") {
  if (text === null || text === undefined || text === "") {
    return `<table:table-cell table:style-name="${styleName}"/>`;
  }
  return (
    `<table:table-cell table:style-name="${styleName}" office:value-type="string">` +
    `<text:p>${xmlEscape(text)}</text:p>` +
    `</table:table-cell>`
  );
}

// ── ODS assembly ────────────────────────────────────────────
const CONTENT_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(" ");

function buildContentXml({ sheetName, headers, rows }) {
  // Column widths: id column narrow-ish, name wider, URL columns wide.
  const colDefs = headers
    .map((_, i) => `<table:table-column table:style-name="co${i === 0 ? "Id" : i === 1 ? "Name" : "Url"}" table:default-cell-style-name="Default"/>`)
    .join("");

  const headerRow =
    `<table:table-row>` + headers.map((h) => textCell(h, "ceHeader")).join("") + `</table:table-row>`;

  const bodyRows = rows
    .map((cells) => `<table:table-row>${cells.join("")}</table:table-row>`)
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<office:document-content ${CONTENT_NS} office:version="1.2">` +
    `<office:automatic-styles>` +
    `<style:style style:name="coId" style:family="table-column"><style:table-column-properties style:column-width="2.6in"/></style:style>` +
    `<style:style style:name="coName" style:family="table-column"><style:table-column-properties style:column-width="1.8in"/></style:style>` +
    `<style:style style:name="coUrl" style:family="table-column"><style:table-column-properties style:column-width="2.2in"/></style:style>` +
    `<style:style style:name="ceHeader" style:family="table-cell">` +
    `<style:table-cell-properties fo:background-color="#e8e8e8"/>` +
    `<style:text-properties fo:font-weight="bold"/>` +
    `</style:style>` +
    `<style:style style:name="ceBody" style:family="table-cell">` +
    `<style:table-cell-properties style:vertical-align="top"/>` +
    `</style:style>` +
    `</office:automatic-styles>` +
    `<office:body><office:spreadsheet>` +
    `<table:table table:name="${xmlEscape(sheetName)}">` +
    colDefs +
    `<table:table-header-rows>${headerRow}</table:table-header-rows>` +
    bodyRows +
    `</table:table>` +
    `</office:spreadsheet></office:body>` +
    `</office:document-content>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<office:document-styles ${CONTENT_NS} office:version="1.2">` +
  `<office:styles>` +
  `<style:style style:name="Default" style:family="table-cell"/>` +
  `</office:styles>` +
  `</office:document-styles>`;

const MANIFEST_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
  `<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>` +
  `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
  `<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>` +
  `</manifest:manifest>`;

/**
 * Zip a staged directory into a valid .ods.
 *
 * ODF requires the `mimetype` entry to be first in the archive and
 * STORED (uncompressed) — hence the two zip passes rather than one.
 */
function writeOds(outPath, contentXml) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ods-"));
  try {
    fs.writeFileSync(path.join(stage, "mimetype"), "application/vnd.oasis.opendocument.spreadsheet");
    fs.mkdirSync(path.join(stage, "META-INF"));
    fs.writeFileSync(path.join(stage, "META-INF", "manifest.xml"), MANIFEST_XML);
    fs.writeFileSync(path.join(stage, "content.xml"), contentXml);
    fs.writeFileSync(path.join(stage, "styles.xml"), STYLES_XML);

    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs)) fs.unlinkSync(abs);

    execFileSync("zip", ["-X", "-0", "-q", abs, "mimetype"], { cwd: stage });
    execFileSync("zip", ["-X", "-9", "-q", "-r", abs, ".", "-x", "mimetype"], { cwd: stage });
    return abs;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ── Data fetch ──────────────────────────────────────────────
/** PostgREST caps responses at 1000 rows; page through all of them. */
async function fetchAllArtists() {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("artists")
      .select("id, name, artist_links(platform, url, not_found)")
      .eq("directory_status", "approved")
      .eq("deleted", false)
      .order("name")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("Fetch failed:", error.message);
      process.exit(1);
    }
    all.push(...data);
    if (data.length < PAGE) return all;
  }
}

async function fetchPlatforms() {
  const { data, error } = await supabase
    .from("platforms")
    .select("key, label, sort_order")
    .order("sort_order")
    .order("key");
  if (error) {
    console.error("Fetch platforms failed:", error.message);
    process.exit(1);
  }
  return data;
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const platforms = await fetchPlatforms();
  const keys = new Set(platforms.map((p) => p.key));
  for (const [flag, value] of [["have", HAVE], ["missing", MISSING]]) {
    if (!keys.has(value)) {
      console.error(
        `--${flag}=${value} is not a known platform key.\n` +
          `Known keys: ${platforms.map((p) => p.key).join(", ")}`
      );
      process.exit(1);
    }
  }

  const artists = await fetchAllArtists();

  const candidates = artists.filter((a) => {
    const links = a.artist_links || [];
    const hasLiveHave = links.some((l) => l.platform === HAVE && !l.not_found && l.url);
    // Any row for MISSING disqualifies — including not_found, which records
    // that the search was already done. Matches getArtistsMissingLink().
    const hasMissingRow = links.some((l) => l.platform === MISSING);
    return hasLiveHave && !hasMissingRow;
  });

  const selected = LIMIT ? candidates.slice(0, LIMIT) : candidates;

  // Column order: the two platforms this export is about come first, then
  // everything else in the platforms table's own display order.
  const rest = platforms.filter((p) => p.key !== HAVE && p.key !== MISSING);
  const columnPlatforms = [
    platforms.find((p) => p.key === HAVE),
    platforms.find((p) => p.key === MISSING),
    ...rest,
  ];

  const headers = ["artist_id", "Artist", ...columnPlatforms.map((p) => p.label)];

  const rows = selected.map((a) => {
    const byPlatform = new Map();
    for (const l of a.artist_links || []) {
      if (l.url) byPlatform.set(l.platform, l.url);
    }
    return [
      textCell(a.id),
      linkCell(a.name, `${SITE_URL}/artist/${a.id}`),
      ...columnPlatforms.map((p) => {
        const url = byPlatform.get(p.key);
        return url ? linkCell(url, url) : textCell("");
      }),
    ];
  });

  const contentXml = buildContentXml({
    sheetName: `${HAVE} missing ${MISSING}`.slice(0, 31),
    headers,
    rows,
  });
  const abs = writeOds(OUT, contentXml);

  console.log(`Approved artists scanned:      ${artists.length}`);
  console.log(`Have live ${HAVE}, missing ${MISSING}: ${candidates.length}`);
  if (LIMIT) console.log(`Written (--limit=${LIMIT}):      ${selected.length}`);
  console.log(`\nWrote ${abs}`);
  if (selected.length === 0) {
    console.log("\nNo candidates — the sheet has headers only.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
