#!/usr/bin/env node
// ============================================================
// SoundCloud bio enrichment.
//
// For each artist with a SoundCloud profile link, fetches their
// public profile page and pulls their full bio from the page's
// hydration data (falling back to the truncated og:description /
// twitter:description meta tag if that isn't found). Stores the
// result in artist_enrichment (platform = 'soundcloud', bio = ...).
//
// Any lines about booking, management, or contact info are split out
// of the bio and stored separately on the artists table
// (booking_info, management_info, contact_info columns).
//
// Any Linktree URL is likewise split out of the bio, but — since a
// Linktree page is just another profile link — it's added to
// artist_links (platform = 'linktree') instead of being stored on the
// artists table, same as the other harvested links below. It's only
// added if the artist doesn't already have a linktree link.
//
// The same page's hydration data also lists the artist's other
// profile links (Instagram, Bandcamp, etc., from SoundCloud's
// "Links" section). Any of these for platforms we don't already
// have a link for are added to artist_links the same way. Twitter/X
// links are always skipped.
//
// No API keys required.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/enrich-bios.mjs                  # run on artists missing a SoundCloud bio
//   node scripts/enrich-bios.mjs --limit=20       # only process the first 20 (for testing)
//   node scripts/enrich-bios.mjs --force          # re-fetch even artists that already have a bio
//   node scripts/enrich-bios.mjs --debug          # log raw web-profile data found per artist
//   DRY_RUN=1 node scripts/enrich-bios.mjs        # fetch + log, but don't write to the DB
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
//
// This makes one HTTP request per artist with a SoundCloud link,
// with a short delay between requests to be polite. For ~1450
// artists a full run can take a while — start with --limit to
// sanity-check results before running on everything.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinktree } from "./lib/linktree.mjs";
import { decodeEntities, isGenericDescription, parseDescription, decodeGateSc } from "./lib/soundcloud-bio.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DEBUG = args.includes("--debug");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const nameArg = args.find((a) => a.startsWith("--name="));
const NAME_FILTER = nameArg ? nameArg.slice("--name=".length) : null;

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

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// decodeEntities, isGenericDescription, parseDescription, decodeGateSc
// are imported from ./lib/soundcloud-bio.mjs above.

// ------------------------------------------------------------
// SoundCloud's og:description / twitter:description meta tags are
// truncated to a short preview (~200 chars, often cut off mid-word).
// The full, untruncated bio is embedded further down the page as JSON
// in a `window.__sc_hydration = [...]` script tag (the data React
// hydrates the page with), under the "user" entry's `description`
// field. We look for that first and only fall back to the meta tag
// (truncated) if it isn't found.
// ------------------------------------------------------------
const HYDRATION_REGEX = /window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);/;

function parseHydration(html) {
  const match = html.match(HYDRATION_REGEX);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function getUserDescription(hydration) {
  const userEntry = Array.isArray(hydration)
    ? hydration.find((h) => h?.hydratable === "user" && h?.data?.description)
    : null;
  return userEntry?.data?.description ?? null;
}

// ------------------------------------------------------------
// Harvesting other profile links (Instagram, Bandcamp, etc.)
//
// SoundCloud's profile pages show a "Links" section pulling in the
// artist's other social/store profiles. In the hydration data this
// shows up as an entry whose `hydratable` key matches /web.?profiles?/
// (e.g. "webProfiles"), with a `data` array of
// { service/network/platform, url, username/title } objects.
//
// We map known services onto our existing link_platform values and
// drop anything we don't recognize into "other" — except Twitter/X,
// which is skipped entirely (by declared service AND by URL host, as
// a backstop) per project policy.
// ------------------------------------------------------------
const NETWORK_PLATFORM_MAP = {
  instagram: "instagram",
  bandcamp: "bandcamp",
  beatport: "beatport",
  qobuz: "qobuz",
  discogs: "discogs",
  residentadvisor: "resident_advisor",
  ra: "resident_advisor",
};

const SKIP_NETWORKS = new Set(["twitter", "x", "xtwitter"]);

function normalizeNetworkKey(value) {
  return (value ?? "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isTwitterHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "twitter.com" ||
      host === "x.com" ||
      host.endsWith(".twitter.com") ||
      host.endsWith(".x.com")
    );
  } catch {
    return false;
  }
}

function extractWebProfiles(hydration) {
  if (!Array.isArray(hydration)) return [];

  if (DEBUG) {
    console.log(
      "  [debug] hydratable types:",
      hydration.map((h) => h?.hydratable).join(", ")
    );
  }

  const entry = hydration.find(
    (h) => typeof h?.hydratable === "string" && /web.?profiles?/i.test(h.hydratable)
  );

  if (DEBUG) {
    console.log("  [debug] webProfiles data:", JSON.stringify(entry?.data ?? null));
  }

  const data = entry?.data;
  if (!Array.isArray(data)) return [];

  return data
    .map((p) => ({
      network: normalizeNetworkKey(p?.service ?? p?.network ?? p?.platform),
      url: typeof p?.url === "string" ? p.url.trim() : null,
      handle: p?.username ?? p?.title ?? null,
    }))
    .filter((p) => p.url);
}

function harvestLinks(hydration) {
  return extractWebProfiles(hydration)
    .filter((p) => !SKIP_NETWORKS.has(p.network) && !isTwitterHost(p.url))
    .map((p) => ({
      platform: NETWORK_PLATFORM_MAP[p.network] ?? "other",
      url: p.url,
      handle: p.handle,
    }));
}

// ------------------------------------------------------------
// Fetch a page, pull its bio (preferring the full untruncated
// description from the hydration data, falling back to the
// og:description/twitter:description meta tag), split it into
// bio/booking/management/contact parts, and harvest any other
// profile links (Instagram, Bandcamp, etc.) from the same hydration
// data. Returns null only if nothing useful was found at all.
// ------------------------------------------------------------
async function fetchSoundCloudInfo(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +bio enrichment)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    if (!res.ok) return null;

    // Read until we find the hydration script (which holds the full
    // bio and the web-profile links) or hit a generous cap — full
    // profile pages, including hydration data, are usually well
    // under this.
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      while (html.length < 2_000_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (HYDRATION_REGEX.test(html)) break;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }

    const hydration = parseHydration(html);
    const harvestedLinks = harvestLinks(hydration);

    let description = getUserDescription(hydration);

    if (!description) {
      const metaRegex =
        /<meta[^>]+(?:property|name)=["'](?:og:description|twitter:description)["'][^>]+content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](?:og:description|twitter:description)["'][^>]*>/i;

      const match = html.match(metaRegex);
      description = match?.[1] ?? match?.[2];
    }

    const empty = {
      bio: null,
      booking: null,
      management: null,
      contact: null,
      linktreeUrl: null,
      harvestedLinks,
    };

    if (!description) {
      return harvestedLinks.length > 0 ? empty : null;
    }

    const decoded = decodeEntities(description).trim();
    if (!decoded || isGenericDescription(decoded)) {
      return harvestedLinks.length > 0 ? empty : null;
    }

    // Decode gate.sc redirect wrappers before searching for Linktree URLs,
    // otherwise linktr.ee URLs hidden inside gate.sc?url=... won't be found.
    const decodedGateSc = decodeGateSc(decoded);
    const { text: withoutLinktree, linktreeUrl } = extractLinktree(decodedGateSc);

    const parsed = parseDescription(withoutLinktree);
    if (
      !parsed.bio &&
      !parsed.booking &&
      !parsed.management &&
      !parsed.contact &&
      !linktreeUrl &&
      harvestedLinks.length === 0
    ) {
      return null;
    }
    return { ...parsed, linktreeUrl, harvestedLinks };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "Running in DRY RUN mode (no writes)\n" : "Running bio enrichment\n");

  let query = supabase
    .from("artists")
    .select(
      "id, name, links:artist_links(platform, url), enrichment:artist_enrichment(platform, bio)"
    )
    .order("name");

  if (NAME_FILTER) {
    query = query.ilike("name", `%${NAME_FILTER}%`);
  }

  if (LIMIT) {
    query = query.limit(LIMIT);
  }

  const { data: artists, error } = await query;
  if (error) throw error;

  let found = 0;
  let notFound = 0;
  let skipped = 0;
  let alreadyHasBio = 0;

  let processed = 0;

  for (const artist of artists) {
    const soundcloudUrl = (artist.links ?? []).find(
      (l) => l.platform === "soundcloud"
    )?.url;

    if (!soundcloudUrl) {
      skipped++;
      continue;
    }

    const existingBio = (artist.enrichment ?? []).find(
      (e) => e.platform === "soundcloud"
    )?.bio;

    if (existingBio && !FORCE) {
      alreadyHasBio++;
      continue;
    }

    processed++;
    const result = await fetchSoundCloudInfo(soundcloudUrl);

    if (result) {
      found++;
      const { bio, booking, management, contact, linktreeUrl, harvestedLinks } = result;

      // Only harvest links for platforms (or, for "other", URLs) the
      // artist doesn't already have a link for.
      const existingLinks = artist.links ?? [];
      const newLinks = [];
      for (const link of harvestedLinks ?? []) {
        const isDup =
          link.platform === "other"
            ? existingLinks.some((l) => l.platform === "other" && l.url === link.url)
            : existingLinks.some((l) => l.platform === link.platform);
        if (isDup) continue;
        newLinks.push(link);
        existingLinks.push({ platform: link.platform, url: link.url });
      }

      // A Linktree URL found in the bio is treated the same way — added
      // to artist_links (platform = 'linktree') unless the artist
      // already has one.
      if (linktreeUrl && !existingLinks.some((l) => l.platform === "linktree")) {
        newLinks.push({ platform: "linktree", url: linktreeUrl, handle: null });
        existingLinks.push({ platform: "linktree", url: linktreeUrl });
      }

      const summary = bio
        ? `"${bio.slice(0, 80)}${bio.length > 80 ? "…" : ""}"`
        : "(no bio text)";
      const extras = [
        booking && "booking",
        management && "management",
        contact && "contact",
        newLinks.length > 0 &&
          `${newLinks.length} link${newLinks.length === 1 ? "" : "s"} (${newLinks
            .map((l) => l.platform)
            .join(", ")})`,
      ].filter(Boolean);
      console.log(
        `✓ ${artist.name}: ${summary}${extras.length ? ` + ${extras.join(", ")}` : ""}`
      );

      if (!DRY_RUN) {
        if (bio) {
          const { error: upsertError } = await supabase
            .from("artist_enrichment")
            .upsert(
              {
                artist_id: artist.id,
                platform: "soundcloud",
                bio: bio ? `SoundCloud bio: ${bio}` : bio,
                last_synced_at: new Date().toISOString(),
              },
              { onConflict: "artist_id,platform" }
            );
          if (upsertError) {
            console.error(`  failed to save bio: ${upsertError.message}`);
          }
        }

        if (booking || management || contact) {
          const update = {};
          if (booking) update.booking_info = booking;
          if (management) update.management_info = management;
          if (contact) update.contact_info = contact;

          const { error: updateError } = await supabase
            .from("artists")
            .update(update)
            .eq("id", artist.id);
          if (updateError) {
            console.error(`  failed to save booking/management/contact: ${updateError.message}`);
          }
        }

        if (newLinks.length > 0) {
          const { error: linksError } = await supabase
            .from("artist_links")
            .upsert(
              newLinks.map((l) => ({
                artist_id: artist.id,
                platform: l.platform,
                url: l.url,
                handle: l.handle,
              })),
              { onConflict: "artist_id,platform,url", ignoreDuplicates: true }
            );
          if (linksError) {
            console.error(`  failed to save harvested links: ${linksError.message}`);
          }
        }
      }
    } else {
      notFound++;
      console.log(`✗ ${artist.name}: no bio found`);
    }

    await sleep(300);

    if (LIMIT && processed >= LIMIT) break;
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  found:              ${found}`);
  console.log(`  not found:          ${notFound}`);
  console.log(`  already had a bio:  ${alreadyHasBio}`);
  console.log(`  skipped (no SoundCloud link): ${skipped}`);
}

main().catch((err) => {
  console.error("\nEnrichment failed:", err?.message ?? err);
  process.exit(1);
});
