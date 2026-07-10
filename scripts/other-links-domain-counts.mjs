#!/usr/bin/env node
// ============================================================
// Domain counts for artist_links where platform = "other"
//
// Fetches every artist_links row with platform="other", extracts the
// hostname from each URL, normalizes near-duplicate domains (www.
// prefixes and known same-service aliases), and counts how many times
// each domain appears. Writes two timestamped CSVs so re-running never
// overwrites a previous report:
//
//   1. Domain counts (e.g. "vice.com, 12")
//   2. Any URL whose hostname has a subdomain beyond "www" (e.g.
//      "thump.vice.com"), so those can be reviewed separately —
//      they're often a distinct site/section, not just the parent
//      domain.
//
// Usage (from rebalance-gender-repo/):
//
//   node scripts/other-links-domain-counts.mjs
//
// Output: other-links-domain-counts-<YYYY-MM-DD_HHMMSS>.csv and
// other-links-subdomains-<YYYY-MM-DD_HHMMSS>.csv (same timestamp),
// written one level up from this repo (i.e. in the "Rebalance Gender"
// folder, not inside rebalance-gender-repo). Each run gets its own
// timestamped files, so previous results are never overwritten.
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\n" +
      "Fill these in in .env.local before running."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY);

// ── Helpers ──────────────────────────────────────────────────

/** Returns the hostname (lowercase, without trailing dot) from a URL string, or null. */
function getHostname(url) {
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

// Known same-service domains that would otherwise split a single
// service's count across near-duplicate hostnames. Keys and values
// are compared after the generic "www." strip below, so list the
// bare (non-www) form on both sides. Add more pairs here as they
// turn up in the report.
const DOMAIN_ALIASES = {
  "itunes.apple.com": "music.apple.com",
  "paypal.me": "paypal.com",
};

/**
 * Normalizes a hostname so trivial variants (www. prefix, known
 * same-service aliases like itunes.apple.com/music.apple.com or
 * paypal.me/paypal.com) collapse into one canonical domain for
 * counting purposes.
 */
function normalizeDomain(hostname) {
  const bare = hostname.replace(/^www\./, "");
  return DOMAIN_ALIASES[bare] ?? bare;
}

/**
 * Splits a hostname into { subdomain, domain } if it has a subdomain
 * beyond "www" (e.g. "thump.vice.com" -> { subdomain: "thump", domain:
 * "vice.com" }). Returns null for bare or www-only hostnames.
 *
 * Naive: assumes a 2-label registrable domain (e.g. "vice.com"), so it
 * will misread two-part TLDs like "co.uk" (e.g. "bbc.co.uk" would be
 * read as subdomain "bbc" of "co.uk"). Good enough for spotting cases
 * like thump.vice.com / open.spotify.com; worth a manual glance at the
 * output for anything on a two-part TLD.
 */
function splitSubdomain(hostname) {
  const bare = hostname.replace(/^www\./, "");
  const labels = bare.split(".");
  if (labels.length <= 2) return null;
  return {
    subdomain: labels.slice(0, -2).join("."),
    domain: labels.slice(-2).join("."),
  };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.error('Fetching artist_links where platform="other"…');

  // PostgREST caps a single select at 1000 rows, so page through with
  // .range() until a short page comes back.
  const PAGE_SIZE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("artist_links")
      .select("id, url, artists(name)")
      .eq("platform", "other")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error("Supabase error:", error.message);
      process.exit(1);
    }

    rows.push(...(page ?? []));
    if (!page || page.length < PAGE_SIZE) break;
  }

  console.error(`Fetched ${rows.length} rows.`);

  // ── Count domains, and collect subdomain URLs ─────────────
  const counts = new Map(); // domain -> count
  const subdomainRows = []; // { id, artistName, url, subdomain, domain }
  let unparseable = 0;
  let noUrl = 0;

  for (const row of rows) {
    const url = row.url;
    if (!url) {
      noUrl++;
      continue;
    }
    const hostname = getHostname(url);
    if (!hostname) {
      unparseable++;
      continue;
    }
    const domain = normalizeDomain(hostname);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);

    const split = splitSubdomain(hostname);
    if (split) {
      subdomainRows.push({
        id: row.id,
        artistName: row.artists?.name ?? "",
        url,
        subdomain: split.subdomain,
        domain: split.domain,
      });
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  subdomainRows.sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.subdomain.localeCompare(b.subdomain)
  );

  console.error(`Domains found : ${sorted.length}`);
  console.error(`URLs with a subdomain : ${subdomainRows.length}`);
  if (unparseable > 0) console.error(`Unparseable URLs skipped : ${unparseable}`);
  if (noUrl > 0) console.error(`Rows with no URL skipped : ${noUrl}`);

  const ts = timestamp();
  const outDir = path.resolve(__dirname, "..", "..");

  // ── Write domain-counts CSV ────────────────────────────────
  const countsHeader = ["domain", "count"];
  const countsCsv =
    [countsHeader.join(",")]
      .concat(sorted.map(([domain, count]) => [csvCell(domain), count].join(",")))
      .join("\n") + "\n";

  const countsPath = path.join(outDir, `other-links-domain-counts-${ts}.csv`);
  fs.writeFileSync(countsPath, countsCsv);
  console.error(`\nWrote ${sorted.length} domains to ${countsPath}`);

  // ── Write subdomains CSV ────────────────────────────────────
  const subdomainsHeader = ["id", "artist_name", "subdomain", "domain", "url"];
  const subdomainsCsv =
    [subdomainsHeader.join(",")]
      .concat(
        subdomainRows.map((r) =>
          [
            r.id,
            csvCell(r.artistName),
            csvCell(r.subdomain),
            csvCell(r.domain),
            csvCell(r.url),
          ].join(",")
        )
      )
      .join("\n") + "\n";

  const subdomainsPath = path.join(outDir, `other-links-subdomains-${ts}.csv`);
  fs.writeFileSync(subdomainsPath, subdomainsCsv);
  console.error(`Wrote ${subdomainRows.length} subdomain URLs to ${subdomainsPath}`);
}

main();
