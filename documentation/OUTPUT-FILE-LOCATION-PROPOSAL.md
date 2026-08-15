# Generated spreadsheets are written outside the repo

> **Status: implemented 2026-08-15.** Written as a proposal alongside the
> repo reorganisation that moved every existing `.csv`/`.ods` out of the
> checkout, then implemented in the following commit. It is kept as the
> reference for *why* the layout is what it is, and as the inventory of
> which script writes what.
>
> Groups A, B, C and E below all now resolve through
> `scripts/lib/output-path.mjs`. Group D (`.cache/`) was deliberately left
> alone. The tables describing "current behaviour" in §2 are a record of
> what the code did *before* the change — the shape of the problem, not
> the state of the tree.

**Target directory:**

```
/Users/maisiebird/Claude/Projects/Rebalance Gender/output files
```

which is `<repo>/../output files` — the sibling of the checkout.

---

## 1. Why

Generated spreadsheets are *data*, not source. They are large, they are
dated, they are produced several at a time by a single run, and they are
never read by the application — only by a human opening LibreOffice. Keeping
them in the checkout has cost us three specific things:

1. **A root directory nobody can scan.** Before this reorganisation the repo
   root held 21 loose `.csv` files against 12 actual project files.
2. **A `.gitignore` permanently one script behind.** The old ignore list had
   eleven hand-written patterns (`hoer-status-resolution-*.csv`,
   `hoer-dupe-artist-delete-*.csv`, …), each added *after* a new script
   littered the root. `hoer-bind-conflicts-*.csv` was still unignored and
   showing up in `git status` at the time of writing.
3. **Three different conventions, none of them documented.** Scripts
   currently write to the repo root, to the repo's `outputs/`, or to the
   directory *above* the repo, and which one a given script picked is an
   accident of when it was written.

The last point is the real problem: a person running the pipeline cannot
predict where a report will land without reading the source.

## 2. Current behaviour — full inventory

Every script that writes a `.csv` or `.ods` to disk, grouped by where it
currently lands. Line numbers are from the reorganisation commit.

### Group A — repo root (`process.cwd()`, or `__dirname/..`)

| Script | Writes | Path source |
|---|---|---|
| `genre-report.mjs` | `genre-report.csv` | `process.cwd()`, `--out=` override |
| `find-duplicates.mjs` | `duplicate-candidates-<ts>.csv` | `process.cwd()`, `--output=` override |
| `resolve-hoer-status.mjs` | `hoer-status-resolution-<ts>.csv`, `hoer-inferred-dupes-review-<ts>.csv`, `hoer-exact-ambiguous-<ts>.csv`, `hoer-link-migration-<ts>.csv` | `process.cwd()` (`outDir`, line 455) |
| `report-hoer-internal-dupes.mjs` | `hoer-internal-dupes-<ts>.csv` | `process.cwd()` |
| `migrate-hoer-dupe-links.mjs` | `hoer-link-migration-applied-<ts>.csv` | `process.cwd()` |
| `delete-hoer-dupe-artists.mjs` | `hoer-dupe-artist-delete-<ts>.csv` | `process.cwd()` |
| `apply-hoer-dupe-review.mjs` | `hoer-dupe-review-applied-<ts>.csv` | `process.cwd()` |
| `resolve-sc-followee-duplicates.mjs` | `sc-followee-duplicates-{dryrun,applied}-<ts>.csv` | `process.cwd()` |
| `integrate-hoer-artists.mjs` | `hoer-bind-conflicts-<ts>.csv`, `hoer-bind-ambiguous-<ts>.csv` | `__dirname/..` |
| `resolve-and-load-links-mb-sp.mjs` | `resolve-candidates-<date>.csv` | `__dirname/..` |
| `apply-genre-status.mjs` | a `.sql` file, only when `--sql-out=` is passed | caller-supplied |

`apply-genre-status.mjs` writes SQL rather than a spreadsheet, so it is out
of scope for the move — but it **reads** `genre-report.csv` from `cwd`, so
it is listed in §5.

### Group B — one level *above* the repo (`__dirname/../..`)

These already write outside the checkout, but into the project folder
itself rather than `output files/` — which is why ~60 `sync-*-failures-*.csv`
and `harvested-link-collisions-*.csv` files are sitting next to the repo.

| Script | Writes |
|---|---|
| `sync-bandcamp.mjs` | `sync-bandcamp-failures-<ts>.csv` |
| `sync-soundcloud.mjs` | `sync-soundcloud-failures-<ts>.csv` |
| `sync-linktree.mjs` | `sync-linktree-failures-<ts>.csv` |
| `integrate-harvested-links.mjs` | `harvested-link-collisions-<ts>.csv` |
| `other-links-domain-counts.mjs` | `other-links-domain-counts-<ts>.csv`, `other-links-subdomains-<ts>.csv` |
| `lookup-soundcloud-by-name.ts` | `soundcloud-lookup-results-<ts>.csv` |

### Group C — the repo's `outputs/` directory

All six call `fs.mkdirSync(dir, { recursive: true })` before writing, which
is why deleting `outputs/` during the reorganisation was safe — they
recreate it on the next run.

| Script | Writes |
|---|---|
| `export-pending-hoer-artists.mjs` | `outputs/pending-hoer-artists-<stamp>.ods`, `--out=` override |
| `export-hoer-sc-followees.mjs` | `outputs/hoer-sc-followees-<stamp>.ods`, `--out=` override |
| `export-lastfm-links.mjs` | `outputs/lastfm-links-<stamp>.ods`, `--out=` override |
| `apply-pending-hoer-decisions.mjs` | `outputs/apply-pending-hoer-decisions-<stamp>.csv` |
| `apply-sc-followee-decisions.mjs` | `outputs/apply-sc-followee-decisions-<stamp>.csv` |
| `bind-hoer-duplicates.mjs` | `outputs/hoer-dupe-ambiguous-<stamp>.csv`, `outputs/bind-hoer-duplicates-<stamp>.csv` |

### Group D — `.cache/` — **do not move**

| Script | Writes |
|---|---|
| `compute-scores.py` | `.cache/pair-scores.csv` (`--output=`) |
| `export-link-backfill-candidates.mjs` | `.cache/backfill-<have>-missing-<missing>.ods` (`--out=`) |

These are intermediate artefacts consumed by another script
(`push-scores.py` reads `.cache/pair-scores.csv`), not human deliverables.
They are already ignored via `.cache/` and should stay where they are —
moving them would put machine-to-machine plumbing in a folder the owner
browses by hand. **Excluded from this proposal.**

### Group E — Python, input-relative

| Script | Writes |
|---|---|
| `review_candidates.py` | `candidates.csv` in `cwd` (`--out`) — **should move** |
| `join-mb-cache.py` | `<input stem> with musicbrainz data.ods`, next to its input — **already correct** |
| `mark-mismatch-not-found.py` | edits `INPUT.ods` in place — **already correct** |

The latter two derive their output location from the input file. Once
inputs live in `output files/`, their outputs follow automatically. No
change needed.

### Group F — not filesystem writers

`src/lib/ods.ts` builds an `.ods` in memory and
`src/app/api/admin/reports/harvest-failures/route.ts` streams it as a browser
download; `scripts/lib/ods-read.mjs` only reads. Nothing to change.

## 3. Proposed change

### 3.1 One helper, one choke point

Add `scripts/lib/output-path.mjs`:

```js
// scripts/lib/output-path.mjs
//
// Single source of truth for where generated spreadsheets go. Every script
// that writes a .csv or .ods for a human to open resolves its path through
// here, so the location is one edit rather than twenty-three.
//
// NOT for .cache/ intermediates — those are machine-to-machine plumbing and
// stay in the checkout (see documentation/OUTPUT-FILE-LOCATION-PROPOSAL.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // scripts/lib
const REPO = path.resolve(HERE, "..", "..");                 // <repo>

/**
 * Absolute path of the output directory.
 *
 * Defaults to the repo's sibling `output files/` — derived from the
 * checkout location rather than hard-coded, so a clone elsewhere still
 * works. Override with REBALANCE_OUTPUT_DIR for a different machine.
 */
export const OUTPUT_DIR = process.env.REBALANCE_OUTPUT_DIR
  ? path.resolve(process.env.REBALANCE_OUTPUT_DIR)
  : path.resolve(REPO, "..", "output files");

/**
 * Resolve `name` inside OUTPUT_DIR and make sure the directory exists.
 * An absolute `name` is honoured as-is, so `--out=/tmp/x.ods` still works.
 */
export function outputPath(name) {
  const abs = path.isAbsolute(name) ? name : path.join(OUTPUT_DIR, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}
```

Deriving the default from `REPO` rather than hard-coding
`/Users/maisiebird/…` matters: `apply-hoer-decisions-2026-07-26.mjs` already
hard-codes that absolute path (line 24) and is the one script that will
break the moment the project folder is renamed or the repo is cloned on
another machine. The helper should not repeat that mistake.

### 3.2 The per-script edit

In every Group A, B and C script the change is two lines. Before:

```js
const outPath = path.resolve(process.cwd(), `hoer-internal-dupes-${timestamp()}.csv`);
```

After:

```js
import { outputPath } from "./lib/output-path.mjs";
...
const outPath = outputPath(`hoer-internal-dupes-${timestamp()}.csv`);
```

The `mkdirSync` calls the Group C scripts already make become redundant —
`outputPath` does it — and should be deleted in the same edit.

### 3.3 `--out=` / `--output=` overrides

Six scripts accept an output override. Today a **relative** override
resolves against `cwd`, which after this change would silently drop a file
back into the repo. Route them through the same helper so that:

- `--out=my-sheet.ods` → `output files/my-sheet.ods`
- `--out=/tmp/my-sheet.ods` → `/tmp/my-sheet.ods` (absolute wins)

For the three `export-*.mjs` scripts this also means the default changes
from `path.join("outputs", …)` to a bare filename:

```js
const OUT = argValue("out", `pending-hoer-artists-${stamp}.ods`);
...
const abs = outputPath(OUT);      // replaces path.resolve(OUT) + mkdirSync
```

### 3.4 Python

`review_candidates.py` is the only Python script that needs it. Rather than
a second helper for one call site, give it the same default via an explicit
constant:

```python
OUTPUT_DIR = Path(os.environ.get("REBALANCE_OUTPUT_DIR")
                  or Path(__file__).resolve().parent.parent.parent / "output files")
...
out_path = Path(args.out) if args.out else OUTPUT_DIR / "candidates.csv"
out_path.parent.mkdir(parents=True, exist_ok=True)
```

If a second Python writer ever appears, promote this to
`scripts/lib/output_path.py` mirroring the `.mjs` helper.

## 4. Rollout — done

All of it landed in one commit. What changed, beyond the mechanical path
swap:

- Six scripts had a `mkdirSync` that `outputPath()` now does; deleted.
- Five had a `path`/`__dirname`/`fileURLToPath` import that existed only to
  build the output path; removed once dead.
- Three logged their result with `path.relative(REPO, …)`, which after the
  move would print `../output files/…`. They print the absolute path now.
- `review_candidates.py` gained an `OUTPUT_DIR` constant rather than a
  second helper module, per §3.4.

Verified: all 361 tests pass, `tsc --noEmit` reports nothing new, eslint is
clean, every `scripts/**/*.mjs` parses, and a static check confirms all 24
files importing the helper import exactly the symbols they use.

## 5. Input paths — the part that will bite

Several scripts *read* a spreadsheet a previous script wrote. Moving the
writers without the readers leaves defaults pointing at nothing.

| Script | Default input | Resolution |
|---|---|---|
| `apply-sc-followee-decisions.mjs` | `outputs/hoer-sc-followees-20260729-211957.ods` | Was **broken** by the file move. Now `resolveInputPath`, and the default filename resolves to the real file. |
| `apply-genre-status.mjs` | `genre-report.csv` in `cwd` | Now `resolveInputPath`; `genre-report.mjs` writes the same name through `outputPath`, so the pair still lines up. |
| `apply-pending-hoer-decisions.mjs` | `<repo>/../pending-hoer-artists-20260726_MOD.ods` | Was **also broken** — that sheet has since moved to `backup files/`. Now `resolveInputPath`, so a bare name looks in `output files/`; the not-found error names the folder it searched. The stale default is left as-is: it is a historical one-off sheet, already applied. |
| `apply-hoer-decisions-2026-07-26.mjs` | absolute path into `output files/` (line 24) | Left alone deliberately — a dated one-off that has already run. It is the cautionary example for §3.1, not a live path. |
| `migrate-hoer-dupe-links.mjs`, `apply-hoer-dupe-review.mjs`, `apply-review-csv.mjs`, `lookup-soundcloud-by-name.ts` | required positional CSV argument | Now `resolveInputPath`, so the reviewed sheet can be named without typing the folder. |
| `migrate.mjs` | three CSVs from `__dirname/../..` (line 252-255) | One-off historical import; left. |

The rule: **a bare filename argument resolves against `OUTPUT_DIR`; an
absolute, `./`-prefixed, or otherwise path-shaped one against `cwd`.** That
keeps `node scripts/apply-review-csv.mjs ./local-edit.csv` working while
`… apply-review-csv.mjs hoer-sc-followees-20260729-211957.ods` finds the
file where it actually lives.

## 6. Documentation updated with the change

- `documentation/PIPELINE.md` — the nine `outputs/…` paths, and a note at
  the top stating where every spreadsheet in the document goes.
- `documentation/MATCHING.md` — "`resolve-candidates-YYYY-MM-DD.csv` in the
  project root" → in the output folder.
- Script header comments that named `outputs/` or "one level up from the
  repo": `bind-hoer-duplicates.mjs`, `export-lastfm-links.mjs`,
  `export-pending-hoer-artists.mjs`, `export-hoer-sc-followees.mjs`,
  `apply-sc-followee-decisions.mjs`, `apply-pending-hoer-decisions.mjs`,
  `integrate-harvested-links.mjs`, `lookup-soundcloud-by-name.ts`,
  `genre-report.mjs`, `apply-genre-status.mjs`.
- `.gitignore` — `/outputs/` dropped. The blanket `*.csv` / `*.ods` rules
  stay; they are the backstop against a future script regressing.

## 7. Alternatives considered

| Option | Why not |
|---|---|
| **Keep `outputs/` in the repo, just gitignore it harder** | This is the status quo, and the status quo is what produced 21 loose CSVs in the root and 60 in the project folder. Ignoring a file does not stop it cluttering `ls`, and it does not answer "where did my report go?". |
| **One `OUTPUT_DIR` env var, required, no default** | Every script would fail on a fresh checkout until the owner set it. A derived default that works out of the box, with an env override for the exceptional case, is strictly better. |
| **Hard-code the absolute path `/Users/maisiebird/…`** | Precisely what `apply-hoer-decisions-2026-07-26.mjs` does, and it is the one script that cannot survive a rename of the project folder or a clone on another machine. |
| **Symlink `outputs/` → `../output files`** | Zero code change, which is genuinely tempting. Rejected: a symlink is invisible in `git status`, it silently un-fixes itself on a fresh clone, and it leaves three *other* conventions (repo root, `__dirname/../..`) untouched — so it solves a third of the problem and hides the rest. |
| **Move `.cache/` writers too, for uniformity** | `.cache/pair-scores.csv` is read by `push-scores.py`, not by a person. Putting plumbing in the folder the owner opens in LibreOffice makes that folder harder to use, which is the thing this proposal is trying to fix. |

## 8. Open questions

1. **Should the failure dumps (Group B) be spreadsheets at all?** Six of the
   ~60 loose files in the project folder are `sync-*-failures-*.csv` written
   on every run, most of them byte-identical to the previous run. A
   `harvest_failures` table already exists and there is an admin report that
   downloads it (`documentation/REPORTS.md`). These CSVs may be redundant —
   worth deciding before mass-moving them.
2. **Retention.** Nothing prunes `output files/`; it has ~100 entries. If
   the answer to (1) is "keep writing them", a `--keep-last=N` or a dated
   subdirectory per run is worth considering at the same time.
3. **Dated subfolders?** `output files/2026-08-15/…` would group a single
   pipeline run's several outputs together. Cheap to add inside
   `outputPath()` now, expensive to retrofit across twenty-three call sites
   later. Decide with (2).
