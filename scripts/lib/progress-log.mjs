// ============================================================
// Quiet-console logging for the Phase 2 stage scripts.
//
// The per-artist harvesters used to print one console line per artist
// (name, follower counts, bio previews, …), which makes an orchestrated
// run's output thousands of lines of detail nobody reads live. This
// module splits that output into two destinations:
//
//   - a LOG FILE gets every per-artist detail line, timestamped
//     (logger.detail). Under the orchestrator every stage appends to
//     one shared per-run file (ENRICHMENT_LOG_FILE, exported by
//     orchestrate-platform-enrichment.mjs); run standalone, a script
//     creates its own logs/<stage>-<timestamp>.log and prints the path
//     once so the details are still findable.
//   - the CONSOLE gets a single in-place progress bar per loop
//     (logger.progressBar) with running ✓/○/✗ tallies, plus the small
//     header/summary lines each stage already printed (logger.info,
//     which mirrors them into the log file too).
//
// The bar renders on stderr: it's transient UI, not output, so
// redirecting a run's stdout to a file captures headers + summaries
// without half-drawn bars in between. On a non-TTY stderr the in-place
// rewrite degrades to an occasional plain progress line.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Env var the orchestrator sets so every child stage appends to the
// same per-run log file.
export const LOG_FILE_ENV = "ENRICHMENT_LOG_FILE";

// One-line preview of a longer text (bio etc.) for log lines: newlines
// collapsed, truncated to `max` characters.
export function preview(text, max = 30) {
  if (!text) return "(none)";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return `"${flat.slice(0, max)}${flat.length > max ? "…" : ""}"`;
}

function timestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function timeOfDay() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Resolve the log file path for a stage: the orchestrator's shared
// per-run file when set, otherwise the stage's own timestamped file
// under <repo>/logs/.
export function resolveLogPath(stageName) {
  const shared = process.env[LOG_FILE_ENV];
  if (shared) return { logPath: shared, shared: true };
  const logsDir = path.join(__dirname, "..", "..", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return {
    logPath: path.join(logsDir, `${stageName}-${timestampForFilename()}.log`),
    shared: false,
  };
}

// ------------------------------------------------------------
// createStageLogger(stageName) — the one object a stage script needs.
//
//   logger.detail(line)  — log file only (per-artist lines).
//   logger.info(line)    — console AND log file (headers, summaries).
//   logger.progressBar(total, label) — console progress bar; returns
//                          { tick(kind), finish() } with kind one of
//                          "ok" | "skip" | "fail" (default "ok").
//   logger.logPath       — where the details went.
//   logger.close()       — flush/close the file stream.
//
// When the stage creates its own file (standalone run, no shared env
// file), the path is announced on the console once at creation.
// ------------------------------------------------------------
export function createStageLogger(stageName) {
  const { logPath, shared } = resolveLogPath(stageName);
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  stream.on("error", (err) => {
    // Logging must never sink the stage itself.
    console.error(`(log file ${logPath} unwritable: ${err.message})`);
  });

  if (!shared) {
    console.log(`Per-artist details → ${logPath}\n`);
  }
  stream.write(`\n──── ${stageName} · ${new Date().toISOString()} ────\n`);

  let activeBar = null;

  const write = (line) => {
    stream.write(`[${timeOfDay()}] ${line}\n`);
  };

  return {
    logPath,

    // Per-artist detail: file only.
    detail(line) {
      write(line);
    },

    // Headers/summaries: console + file. Clears an active bar line
    // first so the text doesn't land mid-bar.
    info(line) {
      if (activeBar) activeBar.clearLine();
      console.log(line);
      write(line);
    },

    progressBar(total, label = stageName) {
      const out = process.stderr;
      const isTTY = Boolean(out.isTTY);
      let done = 0;
      const tallies = { ok: 0, skip: 0, fail: 0 };
      let lastRender = 0;
      let lastPrintedPct = -1;
      let lastPrintedDone = -1;

      const line = () => {
        const width = 24;
        const filled = total > 0 ? Math.round((done / total) * width) : width;
        const bar = "█".repeat(filled) + "░".repeat(width - filled);
        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
        const skips = tallies.skip ? ` ○${tallies.skip}` : "";
        const fails = tallies.fail ? ` ✗${tallies.fail}` : "";
        return `${label} [${bar}] ${done}/${total} (${pct}%) ✓${tallies.ok}${skips}${fails}`;
      };

      const render = (force = false) => {
        if (isTTY) {
          const now = Date.now();
          if (!force && now - lastRender < 100) return;
          lastRender = now;
          out.write(`\r\x1b[2K${line()}`);
        } else {
          // Non-TTY: a plain line every 10% (and at the end) instead of
          // in-place rewrites that would litter a piped log. A forced
          // render (start/finish) is skipped when this count was
          // already printed, so finish() doesn't duplicate the final
          // tick's line.
          const pct = total > 0 ? Math.floor((done / total) * 10) * 10 : 100;
          if ((force || pct > lastPrintedPct) && done !== lastPrintedDone) {
            lastPrintedPct = pct;
            lastPrintedDone = done;
            out.write(`${line()}\n`);
          }
        }
      };

      const bar = {
        tick(kind = "ok") {
          done++;
          if (kind in tallies) tallies[kind]++;
          render();
        },
        // Erase the bar line so a console message can print cleanly;
        // the next tick redraws it.
        clearLine() {
          if (isTTY) out.write("\r\x1b[2K");
        },
        finish() {
          render(true);
          if (isTTY) out.write("\n");
          activeBar = null;
          write(`${label}: ${done}/${total} done — ok ${tallies.ok}, skipped ${tallies.skip}, failed ${tallies.fail}`);
        },
      };

      if (total > 0) render(true);
      activeBar = bar;
      return bar;
    },

    close() {
      stream.end();
    },
  };
}
