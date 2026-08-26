#!/usr/bin/env node
//
// Regenerate src/lib/unaccent-delta.generated.mjs from the live database.
//
//     node scripts/generate-unaccent-delta.mjs
//
// Why this is generated rather than hand-written
// ----------------------------------------------
// The name key that Postgres stores in name_search is
//
//     regexp_replace(lower(public.immutable_unaccent(name)), '[^a-z0-9]', '', 'g')
//
// and the app has to compute the same key for a search term. unaccent() is
// not an algorithm — it is a lookup table (contrib/unaccent's unaccent.rules)
// — so JavaScript cannot derive it. NFD decomposition gets most of the way
// there, because most accented Latin letters are canonically "base letter +
// combining mark", but it silently fails on the letters whose mark lives
// inside the codepoint: NFD leaves "Ø" alone, the [^a-z0-9] strip then
// deletes it, and "ØTTA" normalises to "tta" instead of "otta".
//
// Every hand-maintained fix for that has drifted. This script removes the
// hand: it asks the database what unaccent() does to every character in the
// BMP, keeps only the characters where the NFD path would produce a
// different final key, and writes that delta out as source. The table is
// therefore derived from the authority rather than an approximation of it,
// and src/lib/name-key.test.ts re-checks the assembled function against the
// same authority.
//
// Re-run it after a Postgres upgrade (unaccent.rules ships with the server
// and does change between major versions) and commit the result.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "src", "lib", "unaccent-delta.generated.mjs");

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    "generate-unaccent-delta: SUPABASE_DB_URL is not set (see .env.local).",
  );
  process.exit(1);
}

// The surrogate block has no characters, and chr() raises on it.
const RANGES = [
  [0x00a0, 0xd7ff],
  [0xe000, 0xffff],
];

// Rows come back as "<codepoint> <hex-utf8-of-result>" so that a result
// containing a tab, a newline or a quote can't corrupt the parse.
function probe(lo, hi) {
  const sql = `
    select i, encode(convert_to(public.immutable_unaccent(chr(i)), 'UTF8'), 'hex')
    from generate_series(${lo}, ${hi}) as i
  `;
  const raw = execFileSync("psql", [DB_URL, "-At", "-F", " ", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [cp, hex] = line.split(" ");
    out.push([
      Number(cp),
      Buffer.from(hex ?? "", "hex").toString("utf8"),
    ]);
  }
  return out;
}

/** The final key, given an already-unaccented string. */
const finalKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** What plain NFD decomposition + combining-mark removal would produce. */
const nfdPath = (ch) =>
  finalKey(ch.normalize("NFD").replace(/[̀-ͯ]/g, ""));

const delta = [];
for (const [lo, hi] of RANGES) {
  for (const [cp, unaccented] of probe(lo, hi)) {
    const ch = String.fromCodePoint(cp);
    if (finalKey(unaccented) === nfdPath(ch)) continue;
    delta.push([cp, ch, unaccented]);
  }
}

const body = delta
  .map(([cp, ch, unaccented]) => {
    const key = JSON.stringify(ch);
    const value = JSON.stringify(unaccented);
    const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    return `  ${key}: ${value},${" ".repeat(Math.max(1, 22 - key.length - value.length))}// ${label}`;
  })
  .join("\n");

writeFileSync(
  OUT,
  `// GENERATED FILE — do not edit by hand.
//
// Produced by scripts/generate-unaccent-delta.mjs, which reads the answers
// straight out of Postgres. Regenerate with:
//
//     node scripts/generate-unaccent-delta.mjs
//
// Each entry is a character where Postgres's unaccent() disagrees with plain
// NFD decomposition about the final [a-z0-9] name key — i.e. exactly the
// characters src/lib/name-key.mjs has to special-case. Everything NFD already
// handles (é, ü, ż, ...) is deliberately absent.
//
// ${delta.length} entries.

export const UNACCENT_DELTA = {
${body}
};
`,
  "utf8",
);

console.log(`generate-unaccent-delta: wrote ${delta.length} entries to`);
console.log(`  ${path.relative(process.cwd(), OUT)}`);
