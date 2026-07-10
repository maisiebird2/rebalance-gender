#!/usr/bin/env node
// ============================================================
// Profile image storage script.
//
// Re-hosts artist_images rows to Supabase Storage. artist_images (see
// supabase_migration_artist_images.sql) holds one row per
// (artist_id, platform) — every platform that turned up a usable
// profile photo, written by enrich-images.ts, sync-soundcloud.mjs, and
// sync-bandcamp.mjs. This script downloads each row's source_url and
// uploads it to artist-images/{artist_id}/{platform}.{ext} — one
// Storage object per platform, not one shared slot per artist — then
// writes storage_url/storage_path/stored_at back onto that row.
//
// This replaces the old single-winner design (PLATFORM_PRIORITY-based
// "best" source, written to artists.profile_image_url/source): every
// row in artist_images gets re-hosted, not just one per artist, since
// an artist can now display images from several platforms. See
// scripts/PIPELINE.md, "Multi-image artist_images table".
//
// The SoundCloud-CDN 500×500 resize rewrite (toSize500) is applied
// ONLY to platform === 'soundcloud' rows; every other source is
// fetched at whatever size its stored URL provides.
//
// Failures persist to harvest_failures (service = "image-store:
// <platform>") instead of console-only — download/upload/DB-write
// errors are queryable afterward instead of living only in scrollback,
// same convention as every other harvester in this pipeline. A later
// successful run clears the row.
//
// Each download/upload/DB-write is retried on transient failure
// (exponential backoff, up to 3 retries) before being treated as a
// real failure — added after a run died partway through on a
// stretch of "TypeError: fetch failed" errors, most likely a dead
// connection after a network blip rather than anything wrong with
// those specific images. A row only reaches harvest_failures now if
// it still fails after retries.
//
// Usage (from the rebalance-gender/ folder):
//
//   node scripts/store-images.mjs                  # every artist_images row missing a storage_url
//   node scripts/store-images.mjs --limit=20       # test on first 20
//   node scripts/store-images.mjs --force          # re-download and overwrite already-stored rows too
//   DRY_RUN=1 node scripts/store-images.mjs        # log only, no uploads or DB writes
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { Agent } from "undici";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordFailure, clearFailure } from "./lib/harvest-failures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.env.DRY_RUN === "1";

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

// ------------------------------------------------------------
// Load .env.local
// ------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
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
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local"
  );
  process.exit(1);
}

// Added 2026-07-10, revised same day: a long run died partway through
// on a sustained stretch of "TypeError: fetch failed" — every
// remaining request to Supabase (Storage upload AND a plain
// PostgREST update) failing the same way, immune to in-process
// retries, but a full script restart fixed it. First attempt at a
// fix used `pipelining: 0` on the theory that it would stop undici
// reusing a stale pooled connection — WRONG, verified against
// undici's own docs: pipelining controls something unrelated
// (batching multiple in-flight requests on one connection, not
// keep-alive/reuse), and it changed nothing, confirmed by a second
// identical failure. Replaced with the option that actually controls
// this: a short keepAliveTimeout, so idle sockets get discarded
// quickly instead of lingering long enough to be silently closed
// server-side (proxy/load-balancer idle timeout) without the client
// noticing. Still not confirmed as the actual fix — see
// describeError() below and scripts/PIPELINE.md for how to gather
// real diagnostic data if this happens again, since two guesses in a
// row missed. Passed to both our own fetch() calls and, via
// global.fetch, every call supabase-js makes internally.
const dispatcher = new Agent({ keepAliveTimeout: 4000, keepAliveMaxTimeout: 4000 });

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
  global: { fetch: (url, opts) => fetch(url, { ...opts, dispatcher }) },
});

const BUCKET = "artist-images";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Retry a Supabase call (anything returning { data, error }) on
// transient failures — added 2026-07-10 after a long run died
// partway through with "TypeError: fetch failed" on every remaining
// row (Storage upload AND the harvest_failures write both failed the
// same way), most likely a dead pooled connection after a network
// blip rather than a real per-request error. Restarting the script
// fixed it; this avoids needing a manual restart for the same thing.
// Exponential backoff: 1s, 2s, 4s (3 retries, 4 attempts total).
// ------------------------------------------------------------
async function withRetry(operation, { retries = 3, label = "" } = {}) {
  let result;
  for (let attempt = 0; ; attempt++) {
    result = await operation();
    if (!result.error) return result;
    if (attempt >= retries) return result;
    const delay = 1000 * 2 ** attempt;
    console.log(`    (${label} failed: ${describeError(result.error)} — retrying in ${delay}ms)`);
    await sleep(delay);
  }
}

// ------------------------------------------------------------
// Pull the real underlying network error (ECONNRESET, ETIMEDOUT,
// DNS failure, etc.) out of a Supabase error object — "fetch failed"
// alone is just the generic wrapper name and hides the actual cause.
// postgrest-js (DB calls) already builds this into `.details`.
// storage-js (Storage calls) wraps the raw exception in
// `.originalError`, whose `.cause` holds the real error.
// ------------------------------------------------------------
function describeError(error) {
  if (!error) return "";
  if (error.details) return error.details;
  const cause = error.originalError?.cause;
  if (cause) {
    const code = cause.code ? ` (${cause.code})` : "";
    return `${error.message}\n\nCaused by: ${cause.name ?? "Error"}: ${cause.message ?? cause}${code}`;
  }
  return error.message;
}

// ------------------------------------------------------------
// Rewrite a SoundCloud image URL to request the 500×500 variant.
// SoundCloud encodes the size as a suffix before the extension:
//   …-large.jpg        → 100×100  (most common in og:image)
//   …-t300x300.jpg     → 300×300
//   …-t500x500.jpg     → 500×500  (what we want)
//   …-original.jpg     → original upload
// If the URL doesn't match the expected pattern we leave it as-is.
// ------------------------------------------------------------
function toSize500(url) {
  return url.replace(
    /-(mini|small|badge|t67x67|large|t300x300|crop|t500x500|original)(\.\w+)$/,
    "-t500x500$2"
  );
}

// ------------------------------------------------------------
// Ensure the storage bucket exists and is public.
// (Safe to call every run — Supabase returns a 409 if it already exists.)
// ------------------------------------------------------------
async function ensureBucket() {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024, // 5 MB
  });
  if (error && !error.message.includes("already exists")) {
    throw new Error(`Could not create bucket "${BUCKET}": ${error.message}`);
  }
}

// ------------------------------------------------------------
// Download an image URL and return { buffer, contentType }, or
// { error } on any failure (bad status, timeout, network error).
// ------------------------------------------------------------
async function downloadImage(url, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +profile image storage)",
        },
        redirect: "follow",
        dispatcher,
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType };
    } catch (err) {
      // err.cause carries the underlying network error (e.g. ECONNRESET)
      // that a bare err.message ("fetch failed") hides — surfaced here
      // so a future occurrence is easier to diagnose than this one was.
      const cause = err instanceof Error && err.cause ? ` (cause: ${err.cause.code ?? err.cause.message ?? err.cause})` : "";
      const message = (err instanceof Error ? err.message : String(err)) + cause;
      if (attempt >= retries) return { error: message };
      const delay = 1000 * 2 ** attempt;
      console.log(`    (download ${message} — retrying in ${delay}ms)`);
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ------------------------------------------------------------
// Supabase pagination — PostgREST caps unpaginated queries at 1000
// rows; fetch in pages until a short page signals the end.
// ------------------------------------------------------------
const SUPABASE_PAGE_SIZE = 1000;

// Every artist_images row for a currently-approved, non-deleted
// artist. The artist_images writers already restrict themselves to
// approved artists, but this filter is kept anyway — cheap, and
// defends against a row surviving a later demotion (a deliberate
// choice: demoted artists' images are left in place rather than
// purged, so this filter just makes sure store-images.mjs itself
// never re-hosts on their behalf going forward).
async function fetchImagesToStore() {
  const allRows = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("artist_images")
      .select("artist_id, platform, source_url, storage_url, artists!inner(name, directory_status, deleted)")
      .eq("artists.directory_status", "approved")
      .eq("artists.deleted", false)
      .order("artist_id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);

    if (!FORCE) query = query.is("storage_url", null);

    const { data, error } = await query;
    if (error) throw error;

    allRows.push(...data);
    if (data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }

  return allRows;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? "DRY RUN — no uploads or DB writes\n" : "Storing profile images\n");

  if (!DRY_RUN) {
    await ensureBucket();
    console.log(`Bucket "${BUCKET}" ready.\n`);
  }

  let rows = await fetchImagesToStore();
  console.log(`${rows.length} artist_images row(s) to (re-)store${FORCE ? " (--force)" : ""}.`);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`Processing ${rows.length}.\n`);

  let uploaded = 0;
  let failed = 0;
  // If the connection-pool fix above isn't enough (or something else
  // sustained goes wrong), stop after a run of consecutive failures
  // instead of grinding through the rest of a 1000+ row list — a
  // rerun is safe and cheap (only rows still missing storage_url get
  // reprocessed), so bailing out fast beats burning through every
  // remaining row on a doomed connection.
  const MAX_CONSECUTIVE_FAILURES = 8;
  let consecutiveFailures = 0;
  const bailIfSustainedFailure = () => {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(
        `\n${MAX_CONSECUTIVE_FAILURES} artists in a row failed even after retries — ` +
          `stopping early rather than grinding through the rest. This usually means a ` +
          `sustained connectivity problem, not anything wrong with those specific images. ` +
          `Check your connection and re-run this script — it only reprocesses rows still ` +
          `missing storage_url, so nothing already uploaded is redone.`
      );
      console.log(`  uploaded so far: ${uploaded}`);
      console.log(`  failed so far:   ${failed}`);
      process.exit(1);
    }
  };

  for (const row of rows) {
    const { artist_id: artistId, platform, source_url: rawSourceUrl, artists: artist } = row;
    const service = `image-store:${platform}`;
    // The SoundCloud CDN resize rewrite only makes sense for actual
    // SoundCloud URLs — every other source is fetched at whatever
    // size its own URL provides.
    const sourceUrl = platform === "soundcloud" ? toSize500(rawSourceUrl) : rawSourceUrl;

    process.stdout.write(`${artist.name} (${platform}) … `);

    const downloaded = await downloadImage(sourceUrl);
    if (downloaded.error) {
      console.log(`✗ download failed: ${downloaded.error}`);
      failed++;
      if (!DRY_RUN) {
        await recordFailure(supabase, {
          artistId,
          service,
          status: "download_failed",
          detail: downloaded.error,
          url: sourceUrl,
        });
      }
      bailIfSustainedFailure();
      await sleep(300);
      continue;
    }

    const { buffer, contentType } = downloaded;
    const ext = contentType.includes("png") ? "png" : "jpg";
    const storagePath = `${artistId}/${platform}.${ext}`;
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;

    if (!DRY_RUN) {
      // upsert: overwrite if the file already exists (covers --force).
      const { error: uploadError } = await withRetry(
        () =>
          supabase.storage.from(BUCKET).upload(storagePath, buffer, {
            contentType,
            upsert: true,
          }),
        { label: "upload" }
      );

      if (uploadError) {
        const detail = describeError(uploadError);
        console.log(`✗ upload failed: ${detail}`);
        failed++;
        await recordFailure(supabase, {
          artistId,
          service,
          status: "upload_failed",
          detail,
          url: sourceUrl,
        });
        bailIfSustainedFailure();
        await sleep(300);
        continue;
      }

      const { error: updateError } = await withRetry(
        () =>
          supabase
            .from("artist_images")
            .update({
              storage_url: publicUrl,
              storage_path: storagePath,
              stored_at: new Date().toISOString(),
            })
            .eq("artist_id", artistId)
            .eq("platform", platform),
        { label: "DB update" }
      );

      if (updateError) {
        const detail = describeError(updateError);
        console.log(`✗ DB update failed: ${detail}`);
        failed++;
        await recordFailure(supabase, {
          artistId,
          service,
          status: "write_failed",
          detail,
          url: sourceUrl,
        });
        bailIfSustainedFailure();
        await sleep(300);
        continue;
      }

      await clearFailure(supabase, { artistId, service });
    }

    console.log(`✓ ${Math.round(buffer.length / 1024)} KB → ${publicUrl}`);
    uploaded++;
    consecutiveFailures = 0;
    await sleep(200);
  }

  console.log(`\nDone${DRY_RUN ? " (dry run)" : ""}.`);
  console.log(`  uploaded: ${uploaded}`);
  console.log(`  failed:   ${failed}`);
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
