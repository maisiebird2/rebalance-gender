// ============================================================
// Single source of truth for where generated spreadsheets go.
//
// Every script that writes a .csv or .ods for a *person* to open resolves
// its path through here, so the location is one edit rather than twenty-odd.
// See documentation/OUTPUT-FILE-LOCATION-PROPOSAL.md for the inventory this
// replaced: outputs landed in three different places (the repo root, the
// repo's outputs/, and the directory above the repo) depending on when the
// script was written.
//
// NOT for .cache/ intermediates. pair-scores.csv and the backfill .ods are
// machine-to-machine plumbing read by another script, not deliverables, and
// they stay in the checkout.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // scripts/lib
const REPO = path.resolve(HERE, "..", ".."); // <repo>

/**
 * Absolute path of the output directory.
 *
 * Defaults to the repo's sibling `output files/`, derived from the checkout
 * location rather than hard-coded, so a clone somewhere else still works.
 * Set REBALANCE_OUTPUT_DIR to override.
 */
export const OUTPUT_DIR = process.env.REBALANCE_OUTPUT_DIR
  ? path.resolve(process.env.REBALANCE_OUTPUT_DIR)
  : path.resolve(REPO, "..", "output files");

/**
 * Resolve `name` inside OUTPUT_DIR, creating the directory if needed.
 *
 * An absolute path is honoured as-is, so `--out=/tmp/x.ods` still works.
 *
 * @param   {string} name  bare filename, or an absolute path
 * @returns {string}       absolute path, with its directory guaranteed to exist
 */
export function outputPath(name) {
  const abs = path.isAbsolute(name) ? name : path.join(OUTPUT_DIR, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

/**
 * Resolve a path the user supplied on the command line.
 *
 * The rule: a *bare* filename means "the one in the output folder", because
 * that is where every generated sheet now lives and typing the folder each
 * time is noise. Anything explicitly rooted — absolute, or `./`-prefixed —
 * is resolved against the working directory, so a local scratch copy still
 * wins when you ask for it by an explicit path.
 *
 *   apply-…  hoer-sc-followees-20260729-211957.ods  -> output files/…
 *   apply-…  ./local-edit.ods                       -> $PWD/local-edit.ods
 *   apply-…  /tmp/local-edit.ods                    -> /tmp/local-edit.ods
 *
 * Does not create anything — this is for files that are meant to exist.
 *
 * @param   {string} name  filename or path as typed by the user
 * @returns {string}       absolute path
 */
export function resolveInputPath(name) {
  if (path.isAbsolute(name)) return name;
  if (name.startsWith("./") || name.startsWith("../") || name.includes(path.sep)) {
    return path.resolve(process.cwd(), name);
  }
  return path.join(OUTPUT_DIR, name);
}
