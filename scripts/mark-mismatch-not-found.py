#!/usr/bin/env python3
# ============================================================
# mark-mismatch-not-found.py
#
# Reads an ODS review sheet and, for every row whose "decision"
# column equals "mismatch", marks that artist's MusicBrainz link as
# "not found" in artist_links — i.e. clears the URL and sets
# not_found = true. This mirrors exactly what the artist edit form
# writes when you tick "not found" for the MusicBrainz platform
# (src/app/artist/[id]/edit/actions.ts): a row with
#   { platform: 'musicbrainz', url: null, handle: null, not_found: true }
#
# The artist is identified by the sheet's "artist_id" column (the
# artists.id UUID). By default the script only acts when the link
# currently stored in the DB matches the URL in the sheet, so a stale
# export can't clobber a link that changed since (override with --force).
#
# SAFETY: dry-run by default. It performs only read-only lookups and
# prints a plan. Pass --apply to actually write. Nothing is deleted
# permanently — the original URL is still in the sheet, so a mistaken
# run can be reversed by re-adding the link.
#
# Pure standard library (uses the Supabase REST API via urllib).
#
# Usage (from rebalance-gender/):
#
#   python3 scripts/mark-mismatch-not-found.py INPUT.ods            # dry run
#   python3 scripts/mark-mismatch-not-found.py INPUT.ods --apply    # write
#   python3 scripts/mark-mismatch-not-found.py INPUT.ods --apply --force
#   python3 scripts/mark-mismatch-not-found.py INPUT.ods --status mismatch
# ============================================================

import json
import os
import sys
import zipfile
import urllib.request
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET
from pathlib import Path

TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
NS = {"table": TABLE, "text": TEXT}
REPEAT_CAP = 4096
PLATFORM = "musicbrainz"


# ---- CLI -----------------------------------------------------------------
def parse_args(argv):
    positional, apply, force = [], False, False
    status, decision_col = "mismatch", None
    it = iter(argv)
    for a in it:
        if a == "--apply":
            apply = True
        elif a == "--force":
            force = True
        elif a == "--status":
            status = next(it, status)
        elif a.startswith("--status="):
            status = a.split("=", 1)[1]
        elif a == "--decision-col":
            decision_col = next(it, None)
        elif a.startswith("--decision-col="):
            decision_col = a.split("=", 1)[1]
        elif a in ("-h", "--help"):
            print(__doc__ or "")
            sys.exit(0)
        else:
            positional.append(a)
    if not positional:
        sys.exit("Usage: python3 scripts/mark-mismatch-not-found.py INPUT.ods "
                 "[--apply] [--force] [--status mismatch]")
    return positional[0], apply, force, status, decision_col


# ---- env -----------------------------------------------------------------
def load_env_local():
    envp = Path(__file__).resolve().parent.parent / ".env.local"
    vals = {}
    if not envp.exists():
        return vals
    for line in envp.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        vals[k.strip()] = v
    return vals


# ---- ODS reading ---------------------------------------------------------
def read_ods(path):
    root = ET.fromstring(zipfile.ZipFile(path).read("content.xml"))
    table = root.find(".//table:table", NS)
    if table is None:
        sys.exit(f"No table found in {path}")

    def cell_text(c):
        return "\n".join("".join(p.itertext()) for p in c.findall("text:p", NS))

    rows = []
    for tr in table.findall("table:table-row", NS):
        cells = []
        for tc in tr.findall("table:table-cell", NS):
            rep = int(tc.get(f"{{{TABLE}}}number-columns-repeated", "1"))
            txt = cell_text(tc)
            if txt == "" and rep > REPEAT_CAP:
                break
            cells.extend([txt] * min(rep, REPEAT_CAP))
        while cells and cells[-1] == "":
            cells.pop()
        rows.append(cells)
    while rows and not rows[-1]:
        rows.pop()
    return rows


def col_index(header, name):
    """Exact (case-insensitive) match; returns the single index or errors."""
    matches = [i for i, h in enumerate(header) if h.strip().lower() == name.lower()]
    if not matches:
        sys.exit(f'Column "{name}" not found. Header: {header}')
    return matches[0]


def decision_index(header, data, override, status):
    """Pick the 'decision' column. The sheet can contain duplicates
    (e.g. an empty trailing copy); choose the one that actually carries
    the review values."""
    if override is not None:
        return col_index(header, override)
    matches = [i for i, h in enumerate(header) if h.strip().lower() == "decision"]
    if not matches:
        sys.exit(f'Column "decision" not found. Header: {header}')
    if len(matches) == 1:
        return matches[0]
    # prefer the column containing the target status; else the fullest one
    scored = []
    for i in matches:
        has_status = any((r[i] if i < len(r) else "").strip().lower() == status.lower()
                         for r in data)
        nonempty = sum(1 for r in data if (r[i] if i < len(r) else "").strip())
        scored.append((has_status, nonempty, i))
    scored.sort(reverse=True)
    chosen = scored[0][2]
    print(f'Note: {len(matches)} columns named "decision" (indices {matches}); '
          f"using index {chosen} (the one carrying the review values).")
    return chosen


# ---- Supabase REST -------------------------------------------------------
class Rest:
    def __init__(self, base_url, key):
        self.base = base_url.rstrip("/") + "/rest/v1"
        self.key = key

    def _req(self, method, path, query=None, body=None, prefer=None):
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}") from None

    def get_mb_link(self, artist_id):
        rows = self._req("GET", "/artist_links", query={
            "select": "id,url,handle,not_found",
            "artist_id": f"eq.{artist_id}",
            "platform": f"eq.{PLATFORM}",
        })
        return rows[0] if rows else None

    def mark_not_found(self, artist_id):
        """UPDATE the existing musicbrainz row to the not-found state."""
        return self._req("PATCH", "/artist_links",
                          query={"artist_id": f"eq.{artist_id}",
                                 "platform": f"eq.{PLATFORM}"},
                          body={"url": None, "handle": None, "not_found": True},
                          prefer="return=representation")

    def insert_not_found(self, artist_id):
        return self._req("POST", "/artist_links",
                         body=[{"artist_id": artist_id, "platform": PLATFORM,
                                "url": None, "handle": None, "not_found": True}],
                         prefer="return=representation")


# ---- main ----------------------------------------------------------------
def main():
    inp, apply, force, status, dcol = parse_args(sys.argv[1:])
    inp_path = Path(inp)
    if not inp_path.exists():
        sys.exit(f"Input not found: {inp_path}")

    env = load_env_local()
    base = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY") or env.get("SUPABASE_SECRET_KEY")
    if not base or not key:
        sys.exit("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local")

    rows = read_ods(inp_path)
    if not rows:
        sys.exit("No rows read from input.")
    header, data = rows[0], rows[1:]

    d_idx = decision_index(header, data, dcol, status)
    a_idx = col_index(header, "artist_id")
    u_idx = col_index(header, "url")
    try:
        n_idx = col_index(header, "name")
    except SystemExit:
        n_idx = None

    def get(r, i):
        return (r[i] if (i is not None and i < len(r)) else "").strip()

    targets = [r for r in data if get(r, d_idx).lower() == status.lower()]
    print(f"Input    : {inp_path.name}")
    print(f"Decision : column {d_idx} == \"{status}\" -> {len(targets)} row(s)")
    print(f"Mode     : {'APPLY (writing)' if apply else 'DRY RUN (read-only)'}\n")

    rest = Rest(base, key)
    plan = {"update": 0, "insert": 0, "already": 0, "url_mismatch": 0, "error": 0}

    for r in targets:
        artist_id = get(r, a_idx)
        sheet_url = get(r, u_idx)
        name = get(r, n_idx)
        label = f"{name or artist_id}"

        if not artist_id:
            print(f"  ! SKIP (no artist_id): {label}")
            plan["error"] += 1
            continue

        try:
            existing = rest.get_mb_link(artist_id)
        except RuntimeError as e:
            print(f"  ! ERROR looking up {label}: {e}")
            plan["error"] += 1
            continue

        if existing is None:
            action = "insert"
        elif existing["not_found"] and not existing["url"]:
            print(f"  = already not-found: {label}")
            plan["already"] += 1
            continue
        elif (sheet_url and existing["url"] and existing["url"].strip() != sheet_url
              and not force):
            print(f"  ! URL MISMATCH (skipping, use --force): {label}")
            print(f"        sheet: {sheet_url}")
            print(f"        db   : {existing['url']}")
            plan["url_mismatch"] += 1
            continue
        else:
            action = "update"

        if not apply:
            print(f"  · would {action}: {label}"
                  + (f"  ({existing['url']})" if existing and existing.get("url") else ""))
            plan[action] += 1
            continue

        try:
            if action == "update":
                rest.mark_not_found(artist_id)
            else:
                rest.insert_not_found(artist_id)
            print(f"  ✓ {action}d: {label}")
            plan[action] += 1
        except RuntimeError as e:
            print(f"  ! ERROR writing {label}: {e}")
            plan["error"] += 1

    print("\n" + "-" * 50)
    verb = "Wrote" if apply else "Would"
    print(f"{verb}: {plan['update']} update(s), {plan['insert']} insert(s)")
    if plan["already"]:
        print(f"Already not-found : {plan['already']}")
    if plan["url_mismatch"]:
        print(f"URL mismatch skip : {plan['url_mismatch']}  (re-run with --force to override)")
    if plan["error"]:
        print(f"Errors            : {plan['error']}")
    if not apply:
        print("\nDry run — nothing was written. Re-run with --apply to commit.")


if __name__ == "__main__":
    main()
