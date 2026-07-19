#!/usr/bin/env node
// ============================================================
// resolve-hoer-status.mjs — the HÖR pending-status resolver (main pipeline).
//
// For each HÖR-loaded artist still at directory_status='pending', applies
// these rules IN ORDER and stops at the first that fires:
//
//   1. Exact duplicate     -> `duplicate` + copy its HÖR link onto the survivor
//   2. Inferred duplicate  -> hold for review  (no status change)
//   3. Pronoun eligibility -> `approved` / `not_eligible` (auto-applied)
//   4. Nothing fired       -> stays `pending`
//
// On an exact duplicate the artist's platform='hoer' link is also COPIED onto
// the surviving (matched) artist, so the HÖR association lands on the row that
// stays in the directory instead of being stranded on the `duplicate` row.
// (The standalone migrate-hoer-dupe-links.mjs does the same from a saved report
// — use it to backfill dupes marked before this step existed.)
//
// See scripts/HOER-STATUS-RESOLUTION-PLAN.md for the full design. Run the
// name_search punctuation migration FIRST (this script aborts if it detects
// the migration hasn't been applied) and run report-hoer-internal-dupes.mjs
// (and resolve those by hand) before this.
//
// Outputs (in the current directory, all stamped YYYYMMDD-HHMMSS):
//   hoer-status-resolution-<stamp>.csv        — rows this run CHANGED
//   hoer-inferred-dupes-review-<stamp>.csv    — held for human review
//   hoer-exact-ambiguous-<stamp>.csv          — exact-name collisions to check
//   hoer-link-migration-<stamp>.csv           — HÖR links copied onto survivors
//
// Usage (from the repo root):
//   node scripts/resolve-hoer-status.mjs --dry-run     # compute + write CSVs, no DB writes
//   node scripts/resolve-hoer-status.mjs               # apply for real
//   node scripts/resolve-hoer-status.mjs --debug
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
  loadPronouns,
} from "./lib/hoer-db.mjs";
import {
  normalizeName,
  trigrams,
  bioTokens,
  bioOverlap,
  genreOverlap,
  detectPronoun,
  pronounDecision,
  writeCSV,
  timestamp,
} from "./lib/hoer-resolve.mjs";
import {
  decideHoerLinkCopy,
  buildHoerLinkRow,
  HOER_LINK_AUDIT_COLUMNS,
} from "./lib/hoer-links.mjs";

// ------------------------------------------------------------
// Tuning knobs (see the plan's "Open tuning knobs" section).
// ------------------------------------------------------------
const SHORTLIST_SIM = 0.55; // inferred-dup candidate-shortlist name similarity
const STRONG_NAME_SIM = 0.85; // near-identical name is confident on its own
const CONF_BIO_JACCARD = 0.25; // bio overlap that (with a similar name) is confident
const PRONOUN_THRESHOLD = 0.8; // pronoun dominance ratio for a decision

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run") || process.env.DRY_RUN === "1";
const DEBUG = args.includes("--debug");
const SKIP_MIGRATION_CHECK = args.includes("--skip-migration-check");

loadEnvLocal();

// pg_trgm similarity from two precomputed trigram sets.
function simFromSets(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Abort unless name_search is punctuation-free everywhere — the signal that
// supabase_migration_name_search_strip_punctuation.sql has been applied.
function assertMigrationApplied(artists) {
  const bad = artists.find((a) => a.name_search && /[^a-z0-9]/.test(a.name_search));
  if (bad) {
    console.error(
      "name_search still contains punctuation (e.g. artist " +
        `"${bad.name}" -> "${bad.name_search}").\n` +
        "Run supabase_migration_name_search_strip_punctuation.sql first, or pass\n" +
        "--skip-migration-check to override (exact-duplicate matching will be unreliable)."
    );
    process.exit(1);
  }
}

async function main() {
  console.log(DRY_RUN ? "DRY RUN — no DB writes.\n" : "Applying HÖR status resolution.\n");

  const supabase = createSupabase();
  const fetchAll = makeFetchAll(supabase);

  console.log("Loading data…");
  const hoerLinks = await loadHoerLinks(fetchAll);
  const artists = await loadArtists(fetchAll);
  const bios = await loadBiographies(fetchAll);
  const hoerHarvestedBios = await loadHarvestedBios(fetchAll, "hoer");
  const genreNames = await loadGenreNames(fetchAll);
  const promotedGenres = await loadPromotedGenres(fetchAll, genreNames);
  const hoerGenres = await loadHarvestedGenres(fetchAll, "hoer");
  const pronouns = await loadPronouns(supabase);

  if (!SKIP_MIGRATION_CHECK) assertMigrationApplied(artists);

  const pronounValueById = new Map(pronouns.map((p) => [p.id, p.value]));

  // ---- HÖR bio / genre accessors (HÖR row preferred, harvested fallback) ----
  function hoerBio(artistId) {
    const rows = bios.get(artistId) ?? [];
    const hoer = rows.find((r) => r.platform === "hoer");
    if (hoer?.bio) return hoer.bio;
    return hoerHarvestedBios.get(artistId) ?? "";
  }
  function hoerGenreTags(artistId) {
    return hoerGenres.get(artistId) ?? promotedGenres.get(artistId) ?? [];
  }
  // Any-platform bio text for a candidate (all rows concatenated).
  function candidateBioText(artistId) {
    return (bios.get(artistId) ?? []).map((r) => r.bio).join("\n");
  }

  // ---- Split the world into HÖR vs. everyone else ----
  const artistsById = new Map(artists.map((a) => [a.id, a]));
  const hoerIds = new Set(hoerLinks.keys());

  // Exact-match index: name_search -> [candidate artist ids] (non-HÖR).
  // Also the fuzzy candidate list with precomputed trigram/bio/genre signals.
  const exactIndex = new Map();
  const candidates = [];
  for (const a of artists) {
    if (hoerIds.has(a.id)) continue; // exclude HÖR-loaded artists
    const norm = a.name_search || normalizeName(a.name);
    if (norm) {
      if (!exactIndex.has(norm)) exactIndex.set(norm, []);
      exactIndex.get(norm).push(a.id);
    }
    candidates.push({
      id: a.id,
      name: a.name,
      norm,
      trg: trigrams(norm),
      bioTokenSet: bioTokens(candidateBioText(a.id)),
      genres: promotedGenres.get(a.id) ?? [],
    });
  }

  // ---- The pending HÖR batch ----
  const pending = [];
  for (const id of hoerIds) {
    const a = artistsById.get(id);
    if (!a || a.directory_status !== "pending") continue;
    pending.push(a);
  }
  console.log(
    `HÖR artists: ${hoerIds.size}; pending: ${pending.length}; ` +
      `comparison pool (non-HÖR): ${candidates.length}.\n`
  );

  const runAt = new Date().toISOString();
  const changed = []; // master report rows
  const reviewRows = []; // inferred-dup review rows
  const ambiguousRows = []; // exact-name collisions
  const linkAudit = []; // hoer-link-migration rows (exact dups only)
  const linkInserts = []; // { auditRow, payload } queued for a real run
  const survivorHoerUrl = new Map(); // matchedId -> hoer url assigned this run
  const updateGroups = new Map(); // patch-signature -> { patch, ids: [] }

  function queueUpdate(id, patch) {
    const sig = JSON.stringify(patch);
    if (!updateGroups.has(sig)) updateGroups.set(sig, { patch, ids: [] });
    updateGroups.get(sig).ids.push(id);
  }

  let counts = {
    exact_duplicate: 0,
    inferred_review: 0,
    exact_ambiguous: 0,
    pronoun_approved: 0,
    pronoun_not_eligible: 0,
    stayed_pending: 0,
  };
  let linkCounts = { copied: 0, would_copy: 0, skipped: 0, conflict: 0, error: 0 };

  for (const artist of pending) {
    const norm = artist.name_search || normalizeName(artist.name);
    const url = hoerLinks.get(artist.id)?.url ?? "";
    const bio = hoerBio(artist.id);
    const genres = hoerGenreTags(artist.id);

    // ---------- Rule 1: exact duplicate ----------
    const matches = norm ? exactIndex.get(norm) ?? [] : [];
    if (matches.length === 1) {
      const matchedId = matches[0];
      const matched = artistsById.get(matchedId);
      queueUpdate(artist.id, { directory_status: "duplicate" });
      changed.push({
        run_at: runAt,
        artist_id: artist.id,
        hoer_name: artist.name,
        hoer_url: url,
        rule: "exact_duplicate",
        old_status: artist.directory_status,
        new_status: "duplicate",
        assigned_pronoun: "",
        dominance_ratio: "",
        matched_artist_id: matchedId,
        matched_name: matched?.name ?? "",
        evidence: `exact name_search match on "${norm}"`,
      });
      counts.exact_duplicate++;
      if (DEBUG) console.log(`  [exact dup] ${artist.name} -> ${matched?.name}`);

      // Copy this artist's HÖR link onto the surviving (matched) artist. The
      // matched artist is a non-HÖR candidate, so it has no hoer link of its
      // own — the only collision is two dupes pointing at the same survivor.
      const srcLink = hoerLinks.get(artist.id);
      const auditRow = {
        artist_id: artist.id,
        hoer_name: artist.name,
        matched_artist_id: matchedId,
        matched_name: matched?.name ?? "",
        action: "",
        url: srcLink?.url ?? "",
        note: "",
      };
      if (!srcLink) {
        auditRow.action = "skipped";
        auditRow.note = "source has no hoer link";
        linkCounts.skipped++;
      } else {
        const decision = decideHoerLinkCopy(srcLink.url, survivorHoerUrl.get(matchedId));
        if (decision.action === "copy") {
          survivorHoerUrl.set(matchedId, srcLink.url ?? "");
          if (DRY_RUN) {
            auditRow.action = "would-copy";
            linkCounts.would_copy++;
          } else {
            auditRow.action = "copy-pending";
            linkInserts.push({ auditRow, payload: buildHoerLinkRow(matchedId, srcLink) });
          }
        } else if (decision.action === "skip") {
          auditRow.action = "skipped";
          auditRow.note = decision.note;
          linkCounts.skipped++;
        } else {
          auditRow.action = "conflict";
          auditRow.note = decision.note;
          linkCounts.conflict++;
        }
      }
      linkAudit.push(auditRow);
      continue;
    }
    if (matches.length > 1) {
      for (const matchedId of matches) {
        ambiguousRows.push({
          artist_id: artist.id,
          hoer_name: artist.name,
          hoer_url: url,
          matched_artist_id: matchedId,
          matched_name: artistsById.get(matchedId)?.name ?? "",
        });
      }
      counts.exact_ambiguous++;
      if (DEBUG) console.log(`  [ambiguous] ${artist.name} -> ${matches.length} matches`);
      continue;
    }

    // ---------- Rule 2: inferred duplicate (review only) ----------
    const bioTokenSet = bioTokens(bio);
    const hasBioOrGenres = bioTokenSet.size > 0 || genres.length > 0;
    if (hasBioOrGenres && norm) {
      const artistTrg = trigrams(norm);
      let best = null;
      for (const cand of candidates) {
        const sim = simFromSets(artistTrg, cand.trg);
        if (sim < SHORTLIST_SIM) continue;
        const bioO = bioOverlap(bioTokenSet, cand.bioTokenSet);
        const genreO = genreOverlap(genres, cand.genres);
        const confident =
          sim >= STRONG_NAME_SIM || bioO.jaccard >= CONF_BIO_JACCARD || genreO.count > 0;
        if (!confident) continue;
        const score = sim + bioO.jaccard + Math.min(genreO.count, 3) * 0.1;
        if (!best || score > best.score) {
          best = { cand, sim, bioO, genreO, score };
        }
      }
      if (best) {
        const bits = [`name ${best.sim.toFixed(2)}`];
        if (best.bioO.shared > 0) bits.push(`bio jaccard ${best.bioO.jaccard.toFixed(2)}`);
        if (best.genreO.count > 0) bits.push(`shared genres: ${best.genreO.shared.join(", ")}`);
        reviewRows.push({
          artist_id: artist.id,
          hoer_name: artist.name,
          hoer_url: url,
          matched_artist_id: best.cand.id,
          matched_name: best.cand.name,
          name_similarity: best.sim.toFixed(3),
          bio_overlap: best.bioO.jaccard.toFixed(3),
          shared_genres: best.genreO.count,
          proposed_status: "duplicate",
          decision: "",
        });
        counts.inferred_review++;
        if (DEBUG) console.log(`  [review] ${artist.name} ~ ${best.cand.name} (${bits.join("; ")})`);
        continue; // held — do NOT fall through to pronoun approval
      }
    }

    // ---------- Rule 3: pronoun eligibility ----------
    const detection = detectPronoun(bio, pronouns);
    const decision = pronounDecision(detection, { threshold: PRONOUN_THRESHOLD });
    if (decision.decision === "approved" || decision.decision === "not_eligible") {
      const pronounValue = pronounValueById.get(decision.pronounId) ?? "";
      queueUpdate(artist.id, {
        directory_status: decision.decision,
        pronoun_id: decision.pronounId,
      });
      changed.push({
        run_at: runAt,
        artist_id: artist.id,
        hoer_name: artist.name,
        hoer_url: url,
        rule: decision.decision === "approved" ? "pronoun_approved" : "pronoun_not_eligible",
        old_status: artist.directory_status,
        new_status: decision.decision,
        assigned_pronoun: pronounValue,
        dominance_ratio: detection.dominanceRatio.toFixed(3),
        matched_artist_id: "",
        matched_name: "",
        evidence: `pronoun tokens: ${detection.matchedTokens.join(", ")}`,
      });
      if (decision.decision === "approved") counts.pronoun_approved++;
      else counts.pronoun_not_eligible++;
      if (DEBUG)
        console.log(
          `  [${decision.decision}] ${artist.name} -> ${pronounValue} ` +
            `(ratio ${detection.dominanceRatio.toFixed(2)})`
        );
      continue;
    }

    // ---------- Rule 4: nothing fired ----------
    counts.stayed_pending++;
  }

  // ---- Summary ----
  console.log("Results:");
  console.log(`  exact duplicate (auto):     ${counts.exact_duplicate}`);
  console.log(`  pronoun approved (auto):    ${counts.pronoun_approved}`);
  console.log(`  pronoun not_eligible (auto):${counts.pronoun_not_eligible}`);
  console.log(`  inferred dup (review):      ${counts.inferred_review}`);
  console.log(`  exact ambiguous (review):   ${counts.exact_ambiguous}`);
  console.log(`  stayed pending:             ${counts.stayed_pending}\n`);

  // ---- Apply DB writes ----
  const totalChanges = changed.length;
  if (totalChanges > 0) {
    if (DRY_RUN) {
      console.log(`(dry run) would update ${totalChanges} artist(s).`);
    } else {
      let applied = 0;
      for (const { patch, ids } of updateGroups.values()) {
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500);
          const { error, count } = await supabase
            .from("artists")
            .update(patch)
            .in("id", batch)
            .eq("directory_status", "pending") // guard: only touch still-pending rows
            .select("id", { count: "exact", head: true });
          if (error) console.error(`  update error (${JSON.stringify(patch)}): ${error.message}`);
          else applied += count ?? 0;
        }
      }
      console.log(`✓ Updated ${applied} artist(s).`);
    }
  } else {
    console.log("No automatic status changes this run.");
  }

  // ---- Copy HÖR links onto surviving artists (real run) ----
  if (DRY_RUN) {
    if (linkAudit.length > 0) {
      console.log(
        `(dry run) would copy ${linkCounts.would_copy} HÖR link(s); ` +
          `${linkCounts.skipped} skipped, ${linkCounts.conflict} conflict(s).`
      );
    }
  } else if (linkInserts.length > 0) {
    for (let i = 0; i < linkInserts.length; i += 500) {
      const chunk = linkInserts.slice(i, i + 500);
      const { error } = await supabase.from("artist_links").insert(chunk.map((c) => c.payload));
      if (!error) {
        for (const c of chunk) {
          c.auditRow.action = "copied";
          linkCounts.copied++;
        }
        continue;
      }
      // A batch failed — retry row-by-row so the audit attributes each outcome.
      for (const c of chunk) {
        const { error: e1 } = await supabase.from("artist_links").insert(c.payload);
        if (!e1) {
          c.auditRow.action = "copied";
          linkCounts.copied++;
        } else if (e1.code === "23505") {
          c.auditRow.action = "skipped";
          c.auditRow.note = "survivor already has a hoer link (unique violation)";
          linkCounts.skipped++;
        } else {
          c.auditRow.action = "error";
          c.auditRow.note = e1.message;
          linkCounts.error++;
          console.error(`  link insert error (${c.payload.artist_id}): ${e1.message}`);
        }
      }
    }
    console.log(
      `✓ Copied ${linkCounts.copied} HÖR link(s) onto surviving artists` +
        (linkCounts.conflict ? ` (${linkCounts.conflict} conflict(s) skipped)` : "") +
        (linkCounts.error ? ` (${linkCounts.error} error(s))` : "") +
        "."
    );
  }

  // ---- Write CSVs ----
  const stamp = timestamp();
  const outDir = process.cwd();

  const masterPath = path.resolve(outDir, `hoer-status-resolution-${stamp}.csv`);
  writeCSV(
    masterPath,
    [
      "run_at",
      "artist_id",
      "hoer_name",
      "hoer_url",
      "rule",
      "old_status",
      "new_status",
      "assigned_pronoun",
      "dominance_ratio",
      "matched_artist_id",
      "matched_name",
      "evidence",
    ],
    changed
  );

  const reviewPath = path.resolve(outDir, `hoer-inferred-dupes-review-${stamp}.csv`);
  writeCSV(
    reviewPath,
    [
      "artist_id",
      "hoer_name",
      "hoer_url",
      "matched_artist_id",
      "matched_name",
      "name_similarity",
      "bio_overlap",
      "shared_genres",
      "proposed_status",
      "decision",
    ],
    reviewRows
  );

  const ambiguousPath = path.resolve(outDir, `hoer-exact-ambiguous-${stamp}.csv`);
  writeCSV(
    ambiguousPath,
    ["artist_id", "hoer_name", "hoer_url", "matched_artist_id", "matched_name"],
    ambiguousRows
  );

  const linkPath = path.resolve(outDir, `hoer-link-migration-${stamp}.csv`);
  writeCSV(linkPath, HOER_LINK_AUDIT_COLUMNS, linkAudit);

  console.log("\nWrote:");
  console.log(`  ${masterPath}  (${changed.length} changed)`);
  console.log(`  ${reviewPath}  (${reviewRows.length} to review)`);
  console.log(`  ${ambiguousPath}  (${ambiguousRows.length} collisions)`);
  console.log(
    `  ${linkPath}  (${DRY_RUN ? linkCounts.would_copy + " would copy" : linkCounts.copied + " copied"})`
  );
  console.log(
    "\nNext: review hoer-inferred-dupes-review-*.csv, fill the `decision` column, " +
      "then run apply-hoer-dupe-review.mjs on it."
  );
}

main().catch((err) => {
  console.error("\nFailed:", err?.message ?? err);
  process.exit(1);
});
