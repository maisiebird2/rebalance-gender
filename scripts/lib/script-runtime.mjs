// ============================================================
// How to spawn another scripts/ entry point as a child process.
//
// The scripts here are .mjs but freely import TypeScript from src/lib
// (see scripts/PIPELINE.md), so plain `node` can't load most of them —
// it fails at the first .ts import with ERR_MODULE_NOT_FOUND. Every
// spawner must therefore go through tsx, which runs .mjs and .ts alike.
//
// tsx is located through node's own resolution rather than a
// node_modules/.bin path, so this keeps working from a git worktree,
// where node_modules lives in the main checkout rather than beside the
// script.
// ============================================================

import { createRequire } from "node:module";

/**
 * Command and leading argv for running a scripts/ entry under tsx.
 *
 * @returns {{ command: string, prefixArgs: string[] }}
 */
export function scriptRuntime() {
  return {
    command: process.execPath,
    prefixArgs: [createRequire(import.meta.url).resolve("tsx/cli")],
  };
}
