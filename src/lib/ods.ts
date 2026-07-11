// src/lib/ods.ts
//
// Dependency-free OpenDocument Spreadsheet (.ods) generator.
//
// Why hand-rolled instead of a library: an .ods file is just a ZIP of a
// handful of XML files, and the admin "Reports" section only needs to emit
// simple single-sheet spreadsheets (a header row plus data, with the odd
// hyperlink or date cell). Pulling in exceljs / a full spreadsheet lib for
// that would bloat node_modules for no real gain — and the project's rule is
// to avoid heavy installs. So this module contains two small pieces:
//
//   1. a minimal ZIP writer that stores entries uncompressed (compression
//      method 0), which is all the ODS spec requires — LibreOffice, Excel,
//      and Google Sheets all open a stored-method ODS fine; and
//   2. a tiny OpenDocument content.xml emitter that turns a header + rows
//      into a <table:table>.
//
// The mimetype entry is written first and stored uncompressed, per the ODS
// packaging rules, so the file is recognised as a spreadsheet.

// ── Cell model ────────────────────────────────────────────────────────────

/** A hyperlink cell: displays `text`, links to `href`. */
export interface LinkCell {
  href: string;
  text: string;
}

/** A date/time cell backed by an ISO-8601 string or Date. Rendered as text
 *  but typed as a date so spreadsheet apps can sort/filter it. */
export interface DateCell {
  date: string | Date;
}

export type Cell = string | number | null | undefined | LinkCell | DateCell;

function isLinkCell(c: Cell): c is LinkCell {
  return typeof c === "object" && c !== null && "href" in c;
}
function isDateCell(c: Cell): c is DateCell {
  return typeof c === "object" && c !== null && "date" in c;
}

// ── XML helpers ───────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** OpenDocument date cells want an ISO date-time with no timezone suffix
 *  (office:date-value="2026-07-11T08:15:00"). Normalise to that shape. */
function toOdfDateValue(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  // Keep it timezone-neutral: emit the UTC instant without the trailing "Z".
  return date.toISOString().replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
}

/** Human-readable rendering of a date cell for display inside the sheet. */
function formatDateDisplay(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return typeof d === "string" ? d : "";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function cellXml(cell: Cell): string {
  if (cell === null || cell === undefined || cell === "") {
    return "<table:table-cell/>";
  }
  if (typeof cell === "number") {
    return (
      `<table:table-cell office:value-type="float" office:value="${cell}">` +
      `<text:p>${escapeXml(String(cell))}</text:p>` +
      `</table:table-cell>`
    );
  }
  if (isDateCell(cell)) {
    const value = toOdfDateValue(cell.date);
    const display = formatDateDisplay(cell.date);
    if (!value) {
      return `<table:table-cell office:value-type="string"><text:p>${escapeXml(display)}</text:p></table:table-cell>`;
    }
    return (
      `<table:table-cell office:value-type="date" office:date-value="${value}">` +
      `<text:p>${escapeXml(display)}</text:p>` +
      `</table:table-cell>`
    );
  }
  if (isLinkCell(cell)) {
    return (
      `<table:table-cell office:value-type="string">` +
      `<text:p><text:a xlink:type="simple" xlink:href="${escapeXml(cell.href)}">${escapeXml(cell.text)}</text:a></text:p>` +
      `</table:table-cell>`
    );
  }
  // Plain string.
  return (
    `<table:table-cell office:value-type="string">` +
    `<text:p>${escapeXml(cell)}</text:p>` +
    `</table:table-cell>`
  );
}

// ── content.xml ───────────────────────────────────────────────────────────

export interface Sheet {
  name: string;
  headers: string[];
  rows: Cell[][];
}

function buildContentXml(sheet: Sheet): string {
  const headerRow =
    `<table:table-row table:style-name="ro-header">` +
    sheet.headers
      .map(
        (h) =>
          `<table:table-cell table:style-name="ce-header" office:value-type="string"><text:p>${escapeXml(
            h,
          )}</text:p></table:table-cell>`,
      )
      .join("") +
    `</table:table-row>`;

  const bodyRows = sheet.rows
    .map(
      (row) =>
        `<table:table-row>` + row.map(cellXml).join("") + `</table:table-row>`,
    )
    .join("");

  const columns = sheet.headers
    .map(() => `<table:table-column table:style-name="co-default"/>`)
    .join("");

  // Safe sheet name: ODS forbids a handful of characters in table names.
  const safeName = escapeXml(sheet.name.replace(/[[\]*?:/\\]/g, " ").slice(0, 31) || "Report");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<office:document-content ` +
    `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
    `xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ` +
    `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ` +
    `xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ` +
    `xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `office:version="1.3">` +
    `<office:automatic-styles>` +
    `<style:style style:name="co-default" style:family="table-column">` +
    `<style:table-column-properties style:column-width="4.5cm"/>` +
    `</style:style>` +
    `<style:style style:name="ro-header" style:family="table-row">` +
    `<style:table-row-properties fo:break-before="auto"/>` +
    `</style:style>` +
    `<style:style style:name="ce-header" style:family="table-cell">` +
    `<style:text-properties fo:font-weight="bold"/>` +
    `</style:style>` +
    `</office:automatic-styles>` +
    `<office:body><office:spreadsheet>` +
    `<table:table table:name="${safeName}">` +
    columns +
    headerRow +
    bodyRows +
    `</table:table>` +
    `</office:spreadsheet></office:body>` +
    `</office:document-content>`
  );
}

const MANIFEST_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
  `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>` +
  `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
  `</manifest:manifest>`;

const MIMETYPE = "application/vnd.oasis.opendocument.spreadsheet";

// ── Minimal stored-method ZIP writer ──────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Assemble a ZIP archive with every entry stored uncompressed. */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: 0 = stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    locals.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + entry.data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralPart.length, 12); // central dir size
  eocd.writeUInt32LE(localPart.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localPart, centralPart, eocd]);
}

// ── Public API ────────────────────────────────────────────────────────────

/** Build a single-sheet .ods file and return it as a Buffer. */
export function buildOds(sheet: Sheet): Buffer {
  const contentXml = buildContentXml(sheet);
  return buildZip([
    // mimetype MUST be the first entry and stored uncompressed.
    { name: "mimetype", data: Buffer.from(MIMETYPE, "utf8") },
    { name: "META-INF/manifest.xml", data: Buffer.from(MANIFEST_XML, "utf8") },
    { name: "content.xml", data: Buffer.from(contentXml, "utf8") },
  ]);
}
