#!/usr/bin/env python3
# ============================================================
# join-mb-cache.py
#
# Joins an ODS spreadsheet (one row per artist, with a column of
# MusicBrainz artist URLs) against the local enrich-musicbrainz
# disk cache and writes a NEW ODS with extra MusicBrainz columns.
#
# For each row it takes the MBID from the URL column (the last path
# segment, e.g. .../artist/<mbid>), reads the cached raw MB response
# at <cache>/<mbid>.json, and appends:
#
#     mb_name, mb_gender, mb_tags, mb_type, mb_country, mb_area
#
# Rows whose MBID has no cache file are left blank in those columns
# (and reported in the run summary).
#
# Pure standard library — no pandas / odfpy required.
#
# Usage (from rebalance-gender/):
#
#   python3 scripts/join-mb-cache.py INPUT.ods
#   python3 scripts/join-mb-cache.py INPUT.ods OUTPUT.ods
#   python3 scripts/join-mb-cache.py INPUT.ods --url-col url
#   python3 scripts/join-mb-cache.py INPUT.ods --cache .cache/mb_enrich_v2
#
# Default OUTPUT is "<input stem> with musicbrainz data.ods" next to
# the input. Default cache dir is ../.cache/mb_enrich_v2 relative to
# this script (matching enrich-musicbrainz.mjs).
# ============================================================

import json
import os
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

# ---- ODS XML namespaces --------------------------------------------------
OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
NS = {"office": OFFICE, "table": TABLE, "text": TEXT}

import xml.etree.ElementTree as ET

# Cap on how far a `number-*-repeated` blank filler is expanded. ODS files
# routinely tail off with a single cell/row repeated ~1e6 times to pad the
# grid; expanding those literally would blow up memory. Real data never
# relies on repeats anywhere near this large.
REPEAT_CAP = 4096


# ---- CLI -----------------------------------------------------------------
def parse_args(argv):
    positional = []
    url_col = None
    cache_dir = None
    it = iter(argv)
    for a in it:
        if a == "--url-col":
            url_col = next(it, None)
        elif a.startswith("--url-col="):
            url_col = a.split("=", 1)[1]
        elif a == "--cache":
            cache_dir = next(it, None)
        elif a.startswith("--cache="):
            cache_dir = a.split("=", 1)[1]
        elif a in ("-h", "--help"):
            print(__doc__ or "")
            sys.exit(0)
        else:
            positional.append(a)
    if not positional:
        sys.exit("Usage: python3 scripts/join-mb-cache.py INPUT.ods [OUTPUT.ods] "
                 "[--url-col url] [--cache DIR]")
    inp = positional[0]
    out = positional[1] if len(positional) > 1 else None
    return inp, out, (url_col or "url"), cache_dir


# ---- ODS reading ---------------------------------------------------------
def cell_text(cell):
    """Concatenate the text of every <text:p> in a cell (handles hyperlinks)."""
    parts = []
    for p in cell.findall("text:p", NS):
        parts.append("".join(p.itertext()))
    return "\n".join(parts)


def read_ods(path):
    """Return (rows) where rows is a list of lists of cell strings.

    Trailing empty cells are trimmed per row; fully-empty rows are dropped."""
    with zipfile.ZipFile(path) as z:
        content = z.read("content.xml")
    root = ET.fromstring(content)
    table = root.find(".//table:table", NS)
    if table is None:
        sys.exit(f"No table found in {path}")

    rows = []
    for tr in table.findall("table:table-row", NS):
        rrep = int(tr.get(f"{{{TABLE}}}number-rows-repeated", "1"))
        cells = []
        for tc in tr.findall("table:table-cell", NS):
            crep = int(tc.get(f"{{{TABLE}}}number-columns-repeated", "1"))
            txt = cell_text(tc)
            if txt == "" and crep > REPEAT_CAP:
                # trailing blank filler for the rest of the row — stop here
                break
            cells.extend([txt] * min(crep, REPEAT_CAP))
        # trim trailing empties
        while cells and cells[-1] == "":
            cells.pop()
        if not cells:
            # empty row: don't expand a giant repeat, just record one blank row
            # only if it sits between data rows (we drop trailing ones later)
            rows.append([])
            continue
        rrep = min(rrep, REPEAT_CAP)
        for _ in range(rrep):
            rows.append(list(cells))

    # drop trailing empty rows
    while rows and not rows[-1]:
        rows.pop()
    return rows


# ---- ODS writing ---------------------------------------------------------
def build_content_xml(rows, sheet_name):
    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append(
        '<office:document-content'
        f' xmlns:office="{OFFICE}"'
        f' xmlns:table="{TABLE}"'
        f' xmlns:text="{TEXT}"'
        ' office:version="1.2"><office:body><office:spreadsheet>'
    )
    out.append(f'<table:table table:name="{escape(sheet_name)}">')
    ncols = max((len(r) for r in rows), default=1)
    out.append(f'<table:table-column table:number-columns-repeated="{ncols}"/>')
    for r in rows:
        out.append("<table:table-row>")
        for val in r:
            out.append(
                '<table:table-cell office:value-type="string">'
                f'<text:p>{escape(str(val))}</text:p></table:table-cell>'
            )
        # pad the row out to the full width so the grid is rectangular
        if len(r) < ncols:
            out.append(
                f'<table:table-cell table:number-columns-repeated="{ncols - len(r)}"/>'
            )
        out.append("</table:table-row>")
    out.append("</table:table></office:spreadsheet></office:body></office:document-content>")
    return "".join(out).encode("utf-8")


MANIFEST = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<manifest:manifest'
    ' xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"'
    ' manifest:version="1.2">'
    '<manifest:file-entry manifest:full-path="/"'
    ' manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>'
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>'
    '</manifest:manifest>'
).encode("utf-8")

STYLES = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    f'<office:document-styles xmlns:office="{OFFICE}" office:version="1.2">'
    '</office:document-styles>'
).encode("utf-8")

MIMETYPE = b"application/vnd.oasis.opendocument.spreadsheet"


def write_ods(path, rows, sheet_name):
    content = build_content_xml(rows, sheet_name)
    with zipfile.ZipFile(path, "w") as z:
        # mimetype MUST be first and stored (uncompressed) per the ODF spec
        zi = zipfile.ZipInfo("mimetype")
        zi.compress_type = zipfile.ZIP_STORED
        z.writestr(zi, MIMETYPE)
        z.writestr("META-INF/manifest.xml", MANIFEST, zipfile.ZIP_DEFLATED)
        z.writestr("styles.xml", STYLES, zipfile.ZIP_DEFLATED)
        z.writestr("content.xml", content, zipfile.ZIP_DEFLATED)


# ---- MusicBrainz extraction ----------------------------------------------
def mbid_from_url(url):
    if not url:
        return None
    u = url.strip().split("?")[0].split("#")[0].rstrip("/")
    if not u:
        return None
    return u.split("/")[-1]


def format_tags(tags):
    if not isinstance(tags, list):
        return ""
    # sort by folksonomy vote count (desc), then name; emit names only
    ordered = sorted(
        (t for t in tags if t.get("name")),
        key=lambda t: (-(t.get("count") or 0), t["name"]),
    )
    return ", ".join(t["name"] for t in ordered)


def mb_fields(data):
    """Pull the requested fields out of a raw MB artist response."""
    area = data.get("area")
    area_name = area.get("name") if isinstance(area, dict) else ""
    return {
        "mb_name": data.get("name") or "",
        "mb_gender": data.get("gender") or "",
        "mb_tags": format_tags(data.get("tags")),
        "mb_type": data.get("type") or "",
        "mb_country": data.get("country") or "",
        "mb_area": area_name or "",
    }


NEW_COLS = ["mb_name", "mb_gender", "mb_tags", "mb_type", "mb_country", "mb_area",
            "mb_cache_hit"]


# ---- main ----------------------------------------------------------------
def main():
    inp, out, url_col_name, cache_dir = parse_args(sys.argv[1:])

    inp_path = Path(inp)
    if not inp_path.exists():
        sys.exit(f"Input not found: {inp_path}")

    if cache_dir:
        cache_path = Path(cache_dir)
    else:
        cache_path = Path(__file__).resolve().parent.parent / ".cache" / "mb_enrich_v2"
    if not cache_path.is_dir():
        sys.exit(f"Cache dir not found: {cache_path}")

    if out:
        out_path = Path(out)
    else:
        out_path = inp_path.with_name(f"{inp_path.stem} with musicbrainz data.ods")

    rows = read_ods(inp_path)
    if not rows:
        sys.exit("No rows read from input.")

    header = rows[0]
    # locate the URL column (case-insensitive)
    lower = [h.strip().lower() for h in header]
    try:
        url_idx = lower.index(url_col_name.strip().lower())
    except ValueError:
        sys.exit(f'Column "{url_col_name}" not found. Header is: {header}')

    new_header = header + NEW_COLS
    out_rows = [new_header]

    total = matched = missing = no_mbid = 0
    missing_examples = []

    for r in rows[1:]:
        if not r:
            continue
        total += 1
        url = r[url_idx] if url_idx < len(r) else ""
        mbid = mbid_from_url(url)
        fields = {c: "" for c in NEW_COLS}
        fields["mb_cache_hit"] = "no"

        if not mbid:
            no_mbid += 1
        else:
            cache_file = cache_path / f"{mbid}.json"
            if cache_file.exists():
                try:
                    with open(cache_file, encoding="utf-8") as f:
                        data = json.load(f)
                    fields.update(mb_fields(data))
                    fields["mb_cache_hit"] = "yes"
                    matched += 1
                except (json.JSONDecodeError, OSError) as e:
                    missing += 1
                    if len(missing_examples) < 10:
                        missing_examples.append(f"{mbid} (unreadable: {e})")
            else:
                missing += 1
                if len(missing_examples) < 10:
                    name = r[2] if len(r) > 2 else ""
                    missing_examples.append(f"{mbid} — {name}".rstrip(" —"))

        out_rows.append(r + [fields[c] for c in NEW_COLS])

    sheet_name = inp_path.stem[:120] or "Sheet1"
    write_ods(out_path, out_rows, sheet_name)

    print(f"Read     : {total} data row(s) from {inp_path.name}")
    print(f"Matched  : {matched} (cache hit)")
    print(f"Missing  : {missing} (MBID had no cache file)")
    if no_mbid:
        print(f"No MBID  : {no_mbid} (blank/unparseable URL)")
    if missing_examples:
        print("\nFirst missing MBIDs:")
        for m in missing_examples:
            print(f"  {m}")
    print(f"\nWrote    : {out_path}")


if __name__ == "__main__":
    main()
