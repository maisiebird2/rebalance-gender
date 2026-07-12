// ============================================================
// Shared helpers for the HÖR pending-status resolution scripts.
//
// This module is the single home for the pure, DB-free logic the three
// HÖR resolver scripts share:
//
//   - report-hoer-internal-dupes.mjs   (pre-run worklist)
//   - resolve-hoer-status.mjs          (the precedence pipeline)
//   - apply-hoer-dupe-review.mjs       (round-trip importer)
//
// Everything here is deterministic and side-effect-free so it can be
// unit-tested without a database (see hoer-resolve.test.mjs). The scripts
// own the Supabase reads/writes; this module owns normalization, pronoun
// detection, bio/genre overlap, name similarity, and CSV read/write.
//
// See scripts/HOER-STATUS-RESOLUTION-PLAN.md for the design.
// ============================================================

import fs from "node:fs";

// ------------------------------------------------------------
// Name normalization.
//
// normalizeName() is DEFINED TO MIRROR the post-migration name_search
// generated column exactly:
//
//   regexp_replace(lower(immutable_unaccent(name)), '[^a-z0-9]', '', 'g')
//
// i.e. lowercase -> strip diacritics (unaccent) -> drop every character
// that isn't [a-z0-9] (so both spaces AND punctuation go).
//
// The scripts prefer the DB's own name_search value as the canonical key
// wherever a row already carries one (it's Postgres-computed and therefore
// authoritative). normalizeName() is used for the HÖR-internal report and
// the fuzzy shortlist, and as the yardstick the resolver uses to confirm
// the punctuation-stripping migration has actually been applied.
//
// unaccent() below is a best-effort JS port of Postgres's unaccent
// extension. NFKD decomposition handles the large majority of accented
// Latin letters (é, ü, ñ, ...); a small explicit table covers the
// non-decomposable letters the default unaccent.rules also folds (ø, ß,
// æ, ...). Any divergence can only ever cause a *missed* match, never a
// false one, so the exact-duplicate rule stays conservative.
// ------------------------------------------------------------

const UNACCENT_MAP = {
  ø: "o", Ø: "O",
  ß: "ss",
  æ: "ae", Æ: "AE",
  œ: "oe", Œ: "OE",
  đ: "d", Đ: "D",
  ð: "d", Ð: "D",
  ł: "l", Ł: "L",
  þ: "th", Þ: "TH",
  ı: "i",
  ħ: "h", Ħ: "H",
  ŧ: "t", Ŧ: "T",
  ĸ: "k",
};

export function unaccent(input) {
  if (typeof input !== "string") return "";
  let out = "";
  // NFKD splits e.g. "é" into "e" + combining accent; the combining marks
  // (U+0300–U+036F) are then dropped. Letters with no decomposition are
  // routed through UNACCENT_MAP first.
  for (const ch of input.normalize("NFKD")) {
    if (Object.prototype.hasOwnProperty.call(UNACCENT_MAP, ch)) {
      out += UNACCENT_MAP[ch];
    } else {
      out += ch;
    }
  }
  return out.replace(/[̀-ͯ]/g, "");
}

export function normalizeName(name) {
  if (typeof name !== "string") return "";
  return unaccent(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ------------------------------------------------------------
// Trigram name similarity — a JS port of Postgres pg_trgm similarity(),
// used for the inferred-duplicate candidate shortlist and the
// HÖR-internal report.
//
// pg_trgm pads each word with two leading spaces and one trailing space,
// then takes the set of 3-grams. similarity = |A∩B| / |A∪B| over those
// trigram sets. Because our keys are already normalized to a single
// [a-z0-9] run (no spaces), each key is treated as one word.
// ------------------------------------------------------------

export function trigrams(normalized) {
  const set = new Set();
  if (!normalized) return set;
  const padded = `  ${normalized} `;
  for (let i = 0; i < padded.length - 2; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

export function nameSimilarity(aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  const a = trigrams(aNorm);
  const b = trigrams(bNorm);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ------------------------------------------------------------
// Pronoun detection.
//
// parsePronounTokens("she/her") -> ["she","her"]; splits a pronouns.value
// string on "/" and whitespace, lowercased.
//
// detectPronoun(bio, pronounRows) counts word-boundary, case-insensitive
// occurrences of every pronoun token that appears in the pronouns table,
// then scores each pronoun row (set) by the summed occurrences of its
// member tokens.
//
//   dominant set   = the row with the most token hits
//   totalHits      = total pronoun-token occurrences found in the bio
//   dominanceRatio = dominant.hits / totalHits
//
// Because a shared token like "they" contributes to every set that
// contains it, a mixed "he/they" bio splits its hits across he/him and
// they/them and never lets he/him reach the 0.80 dominance threshold —
// exactly the safety property the plan calls for.
// ------------------------------------------------------------

export function parsePronounTokens(value) {
  if (typeof value !== "string") return [];
  return value
    .toLowerCase()
    .split(/[\/\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const HE_HIM_TOKENS = new Set(["he", "him"]);

// A pronoun row is the he/him set if its tokens are exactly {he, him}.
export function isHeHim(tokens) {
  const set = new Set(tokens);
  if (set.size !== HE_HIM_TOKENS.size) return false;
  for (const t of HE_HIM_TOKENS) if (!set.has(t)) return false;
  return true;
}

// Count word-boundary, case-insensitive occurrences of `token` in `text`.
export function countToken(text, token) {
  if (!text || !token) return 0;
  // token is [a-z]+ in practice; escape defensively anyway.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "gi");
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

export function detectPronoun(bio, pronounRows) {
  const sets = (pronounRows ?? []).map((row) => ({
    id: row.id,
    value: row.value,
    tokens: parsePronounTokens(row.value),
  }));

  // Universe of distinct pronoun tokens across the whole table.
  const tokenCounts = {};
  const universe = new Set();
  for (const s of sets) for (const t of s.tokens) universe.add(t);

  const text = typeof bio === "string" ? bio : "";
  for (const t of universe) tokenCounts[t] = countToken(text, t);

  // totalHits counts each occurrence once, independent of how many sets
  // the token belongs to.
  let totalHits = 0;
  for (const t of universe) totalHits += tokenCounts[t];

  const perSet = sets
    .map((s) => ({
      id: s.id,
      value: s.value,
      tokens: s.tokens,
      hits: s.tokens.reduce((n, t) => n + (tokenCounts[t] ?? 0), 0),
      // distinct member tokens actually present — used only as a tie-break.
      present: s.tokens.filter((t) => (tokenCounts[t] ?? 0) > 0).length,
    }))
    .sort((a, b) => b.hits - a.hits || b.present - a.present || a.id - b.id);

  const dominant = perSet.length > 0 && perSet[0].hits > 0 ? perSet[0] : null;
  const dominanceRatio = dominant && totalHits > 0 ? dominant.hits / totalHits : 0;
  const matchedTokens = [...universe].filter((t) => tokenCounts[t] > 0).sort();

  return { tokenCounts, totalHits, perSet, dominant, dominanceRatio, matchedTokens };
}

// Turn a detection result into a status decision.
//
//   dominant is not he/him AND ratio >= threshold -> approved
//   dominant is     he/him AND ratio >= threshold -> not_eligible
//   otherwise                                      -> pending
//
// In both non-pending cases pronoun_id is set to the dominant set's id.
export function pronounDecision(detection, { threshold = 0.8 } = {}) {
  const { dominant, dominanceRatio } = detection;
  if (!dominant || dominanceRatio < threshold) {
    return { decision: "pending", pronounId: null, dominant: null };
  }
  const heHim = isHeHim(dominant.tokens);
  return {
    decision: heHim ? "not_eligible" : "approved",
    pronounId: dominant.id,
    dominant,
  };
}

// ------------------------------------------------------------
// Bio token overlap — a cheap lowercase, stop-word-stripped Jaccard over
// word tokens. Used as a secondary signal for inferred duplicates.
// ------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from",
  "has", "have", "he", "her", "his", "in", "is", "it", "its", "of", "on",
  "or", "she", "that", "the", "their", "they", "this", "to", "was", "were",
  "who", "will", "with", "you", "your", "i", "we", "our", "but", "not",
  "also", "based", "born", "berlin", "dj", "producer", "artist", "music",
]);

export function bioTokens(text) {
  if (typeof text !== "string") return new Set();
  const normalized = unaccent(text).toLowerCase();
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const out = new Set();
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOP_WORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

// Jaccard overlap of two bio token sets. Returns { jaccard, shared }.
export function bioOverlap(bioA, bioB) {
  const a = bioA instanceof Set ? bioA : bioTokens(bioA);
  const b = bioB instanceof Set ? bioB : bioTokens(bioB);
  if (a.size === 0 || b.size === 0) return { jaccard: 0, shared: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return { jaccard: union === 0 ? 0 : inter / union, shared: inter };
}

// ------------------------------------------------------------
// Genre overlap — normalized set intersection of two genre-name lists.
// HÖR side is the raw_tag list from artist_harvested_genres; candidate
// side is the promoted genres.name list. Compared on a lowercase,
// punctuation-stripped normalization so "Lo-Fi" and "lo fi" match.
// ------------------------------------------------------------

export function normalizeGenre(tag) {
  if (typeof tag !== "string") return "";
  return unaccent(tag).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function genreOverlap(genresA, genresB) {
  const a = new Set((genresA ?? []).map(normalizeGenre).filter(Boolean));
  const b = new Set((genresB ?? []).map(normalizeGenre).filter(Boolean));
  const shared = [];
  for (const g of a) if (b.has(g)) shared.push(g);
  const union = new Set([...a, ...b]).size;
  return { shared, count: shared.length, jaccard: union === 0 ? 0 : shared.length / union };
}

// ------------------------------------------------------------
// CSV read / write — no external deps.
//
// parseCSV handles quoted fields, embedded commas/newlines and ""-escaped
// quotes (same parser the other scripts use). toCSV / writeCSV quote any
// field containing a comma, quote or newline, doubling embedded quotes.
// ------------------------------------------------------------

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const normalized = text.replace(/\r\n/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.length === header.length && r.some((v) => v !== ""))
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => (obj[h.trim()] = (r[idx] ?? "").trim()));
      return obj;
    });
}

function csvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Serialize an array of row objects to CSV text given an explicit column
// order. Missing keys become empty fields.
export function toCSV(columns, rows) {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => csvField(row[col])).join(","));
  }
  return lines.join("\n") + "\n";
}

export function writeCSV(filePath, columns, rows) {
  fs.writeFileSync(filePath, toCSV(columns, rows), "utf-8");
  return filePath;
}

// ------------------------------------------------------------
// YYYYMMDD-HHMMSS local-time stamp for filenames.
// ------------------------------------------------------------
export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}
