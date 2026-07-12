#!/usr/bin/env node
// ============================================================
// report-hoer-internal-dupes.mjs — pre-run worklist (Step 2 of the plan).
//
// HÖR's own site carries near-duplicate artist pages (e.g. /artist/ayako-mori/
// and /artist/ayako-mori-2/). This report surfaces those look-alike PAIRS
// WITHIN THE HÖR BATCH so they can be merged / marked `duplicate` by hand
// BEFORE the main resolver (resolve-hoer-status.mjs) runs against the rest of
// the directory.
//
// It changes no data — it only writes hoer-internal-dupes-<stamp>.csv.
//
// For every pair of HÖR-loaded artists it scores:
//   - name_similarity : pg_trgm-style similarity of the normalized names
//   - bio_overlap     : stop-word-stripped Jaccard of their HÖR bios
//   - shared_genres   : normalized overlap of their HÖR genre tags
// and emits the pair when the names are similar enough (default >= 0.55,
// --min-name-sim=) OR the bio+genre signals independently look like a match.
//
// Usage (from the repo root):
//   node scripts/report-hoer-internal-dupes.mjs
//   node scripts/report-hoer-internal-dupes.mjs --min-name-sim=0.5 --debug
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import path from "node:path";
import {
  loadEnvLocal,
  createSupabase,
  makeFetchAll,
  loadHoerLinks,
  loadArtists,
  loadBiographies,
  loadHarvestedBios,
  loadGenreNames,
  loadPromotedGenres,
  loadHarvestedGenres,
} from "./lib/hoer-db.mjs";
import {
  normalizeName,
  trigrams,
  bioTokens,
  bioOverlap,
  genreOverlap,
  writeCSV,
  timestamp,
} from "./lib/hoer-resolve.mjs";

// pg_trgm similarity from two precomputed trigram sets (avoids rebuilding
// trigrams on every pair in the O(n²) comparison below).
function simFromSets(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const args = process.argv.slice(2);
const DEBUG = args.includes("--debug");
const minSimArg = args.find((a) => a.startsWith("--min-name-sim="));
const MIN_NAME_SIM = minSimArg ? parseFloat(minSimArg.split("=")[1]) : 0.55;
// A pair below MIN_NAME_SIM is still surfaced if the bio + genre evidence is
// strong on its own (different HÖR spellings of the same act).
const STRONG_BIO_JACCARD = 0.5;

loadEnvLocal();

async function main() {
  const supabase = createSupabase();
  const fetchAll = makeFetchAll(supabase);

  console.log("Loading HÖR batch…");
  const hoerLinks = await loadHoerLinks(fetchAll);
  const artistsById = new Map((await loadArtists(fetchAll)).map((a) => [a.id, a]));
  const bios = await loadBiographies(fetchAll);
  const hoerHarvestedBios = await loadHarvestedBios(fetchAll, "hoer");
  const genreNames = await loadGenreNames(fetchAll);
  const promotedGenres = await loadPromotedGenres(fetchAll, genreNames);
  const hoerGenres = await loadHarvestedGenres(fetchAll, "hoer");

  // HÖR bio: prefer the cleaned biographies row (platform='hoer'), fall back
  // to the raw harvested bio.
  function hoerBio(artistId) {
    const rows = bios.get(artistId) ?? [];
    const hoer = rows.find((r) => r.platform === "hoer");
    if (hoer?.bio) return hoer.bio;
    return hoerHarvestedBios.get(artistId) ?? "";
  }
  // HÖR genre tags: prefer the harvested HÖR tags; fall back to promoted.
  function hoerGenreTags(artistId) {
    return hoerGenres.get(artistId) ?? promotedGenres.get(artistId) ?? [];
  }

  // Build the batch, skipping HÖR ids that have no live artist row (deleted).
  const batch = [];
  for (const [artistId, link] of hoerLinks) {
    const artist = artistsById.get(artistId);
    if (!artist) continue;
    const norm = artist.name_search || normalizeName(artist.name);
    batch.push({
      id: artistId,
      name: artist.name,
      norm,
      trg: trigrams(norm),
      url: link.url,
      bioTokenSet: bioTokens(hoerBio(artistId)),
      genres: hoerGenreTags(artistId),
    });
  }
  console.log(`HÖR batch: ${batch.length} artist(s). Comparing pairs…`);

  // Pairwise comparison. O(n²) but this is a one-off local run.
  const pairs = [];
  for (let i = 0; i < batch.length; i++) {
    const a = batch[i];
    if (!a.norm) continue;
    for (let j = i + 1; j < batch.length; j++) {
      const b = batch[j];
      if (!b.norm) continue;
      const sim = simFromSets(a.trg, b.trg);
      const bio = bioOverlap(a.bioTokenSet, b.bioTokenSet);
      const genre = genreOverlap(a.genres, b.genres);

      const strongOtherSignal = bio.jaccard >= STRONG_BIO_JACCARD && genre.count > 0;
      if (sim < MIN_NAME_SIM && !strongOtherSignal) continue;

      const evidenceBits = [`name ${sim.toFixed(2)}`];
      if (bio.shared > 0) evidenceBits.push(`bio jaccard ${bio.jaccard.toFixed(2)}`);
      if (genre.count > 0) evidenceBits.push(`shared genres: ${genre.shared.join(", ")}`);

      pairs.push({
        artist_id_a: a.id,
        name_a: a.name,
        url_a: a.url,
        artist_id_b: b.id,
        name_b: b.name,
        url_b: b.url,
        name_similarity: sim.toFixed(3),
        bio_overlap: bio.jaccard.toFixed(3),
        shared_genres: genre.count,
        evidence: evidenceBits.join("; "),
        _sortSim: sim,
        _sortGenres: genre.count,
        _sortBio: bio.jaccard,
      });

      if (DEBUG) console.log(`  ~ ${a.name} ⇔ ${b.name}  (${evidenceBits.join("; ")})`);
    }
  }

  // Most confident first: name similarity, then shared genres, then bio.
  pairs.sort(
    (p, q) =>
      q._sortSim - p._sortSim || q._sortGenres - p._sortGenres || q._sortBio - p._sortBio
  );

  const columns = [
    "artist_id_a",
    "name_a",
    "url_a",
    "artist_id_b",
    "name_b",
    "url_b",
    "name_similarity",
    "bio_overlap",
    "shared_genres",
    "evidence",
  ];
  const outPath = path.resolve(process.cwd(), `hoer-internal-dupes-${timestamp()}.csv`);
  writeCSV(outPath, columns, pairs);

  console.log(`\n${pairs.length} candidate pair(s) written to:\n  ${outPath}`);
  console.log(
    "\nResolve these by hand (merge / mark `duplicate`) before running resolve-hoer-status.mjs."
  );
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
