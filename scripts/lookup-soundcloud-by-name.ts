#!/usr/bin/env -S npx tsx
// Look up SoundCloud users for a list of DJ names and write matches
// (>= 20 followers) to a timestamped CSV, carrying through every input
// column plus three new ones: sc_result_name, sc_url, follower_count.
//
// Usage:
//   npx tsx scripts/lookup-soundcloud-by-name.ts path/to/input.csv
//
// Input CSV must have a header row with (at least) these columns:
//   hor_name, hor_url, hor_date, hor_genres
// Only hor_name is used — it's what gets searched on SoundCloud.
//
// Output: soundcloud-lookup-results-<YYYY-MM-DD_HHMMSS>.csv, written one
// level up from this repo (i.e. in the "Rebalance Gender" folder, not
// inside rebalance-gender-repo). Each run gets its own timestamped file,
// so previous results are never overwritten.
//
// URL cleaning reuses the same normalizeProfileLink() logic the website
// uses for SoundCloud profile links (src/lib/profile-links.ts), so the
// output URL matches exactly what would be stored for an artist.
//
// Requires SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET in .env.local
// (same credentials used by sync-soundcloud.mjs). Uses the OAuth
// client-credentials flow — app-only, public resources.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProfileLink } from "../src/lib/profile-links.js";
import { cleanLinkUrl } from "../src/lib/platforms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
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

const SOUNDCLOUD_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const SOUNDCLOUD_CLIENT_SECRET = process.env.SOUNDCLOUD_CLIENT_SECRET;

if (!SOUNDCLOUD_CLIENT_ID || !SOUNDCLOUD_CLIENT_SECRET) {
  console.error(
    "Missing SOUNDCLOUD_CLIENT_ID or SOUNDCLOUD_CLIENT_SECRET.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}

const csvPathArg = process.argv[2];
if (!csvPathArg) {
  console.error(
    "Usage: npx tsx scripts/lookup-soundcloud-by-name.ts path/to/input.csv\n" +
      "Input CSV needs a header row with a hor_name column."
  );
  process.exit(1);
}
const csvPath = path.resolve(process.cwd(), csvPathArg);
if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

// ── Minimal RFC-4180-ish CSV parser (handles quoted cells, escaped
//    quotes, commas and newlines inside quotes) — same parser used by
//    scripts/apply-genre-status.mjs. ──
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c === "\r") {
      // ignore; handled by \n
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// Cleans a raw SoundCloud permalink_url the same way the website cleans
// a pasted SoundCloud link: normalizeProfileLink handles the templated
// soundcloud.com/<handle> case; cleanLinkUrl is the generic fallback
// (only relevant for non-templated platforms, kept here to match the
// resolveProfileLinkUrl signature).
function cleanSoundcloudUrl(rawUrl: string): string {
  return normalizeProfileLink("soundcloud", rawUrl).url || cleanLinkUrl("soundcloud", rawUrl);
}

interface InputRow {
  hor_name: string;
  hor_url: string;
  hor_date: string;
  hor_genres: string;
}

function loadInputRows(csv: string): InputRow[] {
  const table = parseCsv(fs.readFileSync(csv, "utf8")).filter(
    (r) => r.length && r.some((c) => c !== "")
  );
  if (table.length < 2) {
    console.error("Input CSV has no data rows.");
    process.exit(1);
  }
  const header = table[0].map((h) => h.trim());
  const nameIdx = header.indexOf("hor_name");
  if (nameIdx === -1) {
    console.error(`Input CSV is missing a "hor_name" column. Found columns: ${header.join(", ")}`);
    process.exit(1);
  }
  const urlIdx = header.indexOf("hor_url");
  const dateIdx = header.indexOf("hor_date");
  const genresIdx = header.indexOf("hor_genres");
  return table.slice(1).map((r) => ({
    hor_name: (r[nameIdx] ?? "").trim(),
    hor_url: urlIdx === -1 ? "" : (r[urlIdx] ?? "").trim(),
    hor_date: dateIdx === -1 ? "" : (r[dateIdx] ?? "").trim(),
    hor_genres: genresIdx === -1 ? "" : (r[genresIdx] ?? "").trim(),
  }));
}

interface SoundcloudUser {
  username: string;
  permalink_url: string;
  followers_count?: number;
}

async function getAccessToken(): Promise<string> {
  const basic = Buffer.from(`${SOUNDCLOUD_CLIENT_ID}:${SOUNDCLOUD_CLIENT_SECRET}`).toString(
    "base64"
  );
  const res = await fetch("https://secure.soundcloud.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json; charset=utf-8",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token request failed (HTTP ${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function searchUsers(
  token: string,
  query: string,
  limit = 5
): Promise<{ ok: true; data: SoundcloudUser[] } | { ok: false; status: number; text: string }> {
  const url = `https://api.soundcloud.com/users?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json; charset=utf-8",
      Authorization: `OAuth ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, text };
  }
  const data = await res.json();
  return { ok: true, data };
}

interface ResultRow extends InputRow {
  scName: string;
  scUrl: string;
  followers: number;
}

const MIN_FOLLOWERS = 20;

async function main() {
  const inputRows = loadInputRows(csvPath);
  const token = await getAccessToken();
  const rows: ResultRow[] = [];

  for (const inputRow of inputRows) {
    const name = inputRow.hor_name;
    if (!name) continue;
    console.log(`\n=== ${name} ===`);
    const result = await searchUsers(token, name, 5);
    if (!result.ok) {
      console.log(`  ERROR ${result.status}: ${result.text}`);
      continue;
    }
    if (!result.data.length) {
      console.log("  No results");
      continue;
    }
    for (const u of result.data) {
      const followers = u.followers_count ?? 0;
      if (followers < MIN_FOLLOWERS) {
        console.log(`  (skipped, < ${MIN_FOLLOWERS} followers) ${u.username} — ${u.permalink_url} (followers: ${followers})`);
        continue;
      }
      const cleanUrl = cleanSoundcloudUrl(u.permalink_url);
      console.log(`  ${u.username} — ${cleanUrl} (followers: ${followers})`);
      rows.push({ ...inputRow, scName: u.username, scUrl: cleanUrl, followers });
    }
  }

  rows.sort((a, b) => a.hor_name.localeCompare(b.hor_name) || b.followers - a.followers);

  const header = ["hor_name", "hor_url", "hor_date", "hor_genres", "sc_result_name", "sc_url", "follower_count"];
  const csvOut = [header.join(",")]
    .concat(
      rows.map((r) =>
        [
          csvCell(r.hor_name),
          csvCell(r.hor_url),
          csvCell(r.hor_date),
          csvCell(r.hor_genres),
          csvCell(r.scName),
          csvCell(r.scUrl),
          csvCell(r.followers),
        ].join(",")
      )
    )
    .join("\n");

  // One level up from the repo, i.e. in the "Rebalance Gender" folder.
  const outPath = path.resolve(__dirname, "..", "..", `soundcloud-lookup-results-${timestamp()}.csv`);
  fs.writeFileSync(outPath, csvOut);
  console.log(`\nWrote ${rows.length} row(s) to ${outPath}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
