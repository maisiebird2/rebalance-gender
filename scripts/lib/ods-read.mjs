// ============================================================
// Minimal OpenDocument Spreadsheet (.ods) reader.
//
// The counterpart to src/lib/ods.ts, which writes them. An .ods is a ZIP
// of XML, so reading one is: unzip content.xml, walk the rows and cells of
// the requested sheet. Same reasoning as the writer — no dependency is
// worth it for "read a review sheet back in".
//
// Handles the two things real sheets do that a naive parser trips on:
// self-closing <table:table-cell/> for blanks, and
// table:number-columns-repeated on runs of identical cells (LibreOffice
// emits a repeat of 1000+ for the empty tail of a row, hence the cap).
//
// Cell values come back as trimmed strings; a cell holding a hyperlink
// yields its display text, which is why exports that need to be read back
// write the URL as the link text too.
// ============================================================

import { execFileSync } from "node:child_process";
import path from "node:path";

// A repeated-cell run is capped rather than expanded verbatim: the tail of
// a LibreOffice row can claim tens of thousands of empty columns.
const MAX_REPEAT = 200;

export function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Every sheet in the file, as a Map of name -> inner XML. */
function readSheets(odsPath) {
  const xml = execFileSync("unzip", ["-p", odsPath, "content.xml"], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const sheets = new Map();
  for (const m of xml.matchAll(/<table:table ([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = m[1].match(/table:name="([^"]*)"/)?.[1];
    if (name != null) sheets.set(unescapeXml(name), m[2]);
  }
  return sheets;
}

/** Rows of a sheet as arrays of trimmed cell strings, trailing blanks dropped. */
function rowsOf(sheetXml) {
  const rows = [];
  for (const rowXml of sheetXml.matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
    const cells = [];
    for (const cellXml of rowXml[1].matchAll(
      /<table:table-cell([^>]*)\/>|<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>/g
    )) {
      const attrs = cellXml[1] ?? cellXml[2] ?? "";
      const body = cellXml[3] ?? "";
      const rep = Number(attrs.match(/table:number-columns-repeated="(\d+)"/)?.[1] ?? "1");
      const paras = [...body.matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g)].map((p) =>
        unescapeXml(p[1].replace(/<[^>]+>/g, ""))
      );
      const value = paras.join("\n").trim();
      for (let i = 0; i < Math.min(rep, MAX_REPEAT); i++) cells.push(value);
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * Read one sheet as an array of objects keyed by its header row.
 *
 * @param odsPath        path to the .ods file
 * @param opts.sheet     sheet name; falls back to the only sheet when the
 *                       file has exactly one, otherwise throws and lists
 *                       what the file does contain
 * @param opts.required  column names that must be present in the header
 */
export function readOdsRows(odsPath, { sheet, required = [] } = {}) {
  const sheets = readSheets(odsPath);
  const sheetXml =
    (sheet != null ? sheets.get(sheet) : undefined) ??
    (sheets.size === 1 ? [...sheets.values()][0] : undefined);
  if (sheetXml == null)
    throw new Error(
      `Sheet ${sheet != null ? `"${sheet}" ` : ""}not found in ${path.basename(odsPath)} — ` +
        `sheets present: ${[...sheets.keys()].map((n) => `"${n}"`).join(", ") || "(none)"}`
    );

  const rows = rowsOf(sheetXml);
  const [header = [], ...rest] = rows;
  const trimmed = header.map((h) => h.trim());
  const missing = required.filter((c) => !trimmed.includes(c));
  if (missing.length)
    throw new Error(
      `${path.basename(odsPath)} is missing required column(s): ${missing.join(", ")} — ` +
        `header is: ${trimmed.join(" | ")}`
    );

  return rest.map((r) => Object.fromEntries(trimmed.map((h, i) => [h, r[i] ?? ""])));
}
