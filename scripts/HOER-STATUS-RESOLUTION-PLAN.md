# HÖR pending-status resolution — implementation plan

Automated resolution of `directory_status` for artists seeded from HÖR
(https://hoer.live) that currently sit at `pending`. Goal: clear as many as we
confidently can, hold the uncertain ones for human review, and record every
automated change in a dated CSV.

Status: **scripts implemented** (committed Jul 11, `7daab17`) against this plan;
not yet run. Any further changes go on a new branch off `main` (project rule).
These scripts hit Supabase, so they can't be run or verified in the Cowork
sandbox — they'll be handed to Maisie to run locally.

---

## Grounding in the current schema

| Thing | Where |
|---|---|
| Artist row | `artists(id uuid, name, pronoun_id int, directory_status enum, name_search generated, deleted)` |
| Status enum values | `approved, pending, rejected, not_eligible, search_input, sc_followee, duplicate, unverified` — `approved` / `not_eligible` / `duplicate` all exist |
| Pronouns | `pronouns(id int, value text unique)` — `value` strings seeded separately; confirm actual set on first run |
| HÖR membership | `artist_links` where `platform='hoer'` (join to `artists`) |
| HÖR bio | `biographies` where `platform='hoer'` (`bio` column); raw audit copy in `artist_harvested_bios` (`source_platform='hoer'`, `raw_bio`) |
| HÖR genres | `artist_harvested_genres` where `source_platform='hoer'` (`raw_tag`, plus promoted `genre_id`) |
| Promoted genres (any artist) | `artist_genres` → `genres` |

Caveats baked into the plan:

- `name_search` strips both spaces **and** punctuation (diacritics folded,
  lowercased), so it is a valid exact-dup key. This was a long-intended change,
  already applied via `supabase_migration_name_search_strip_punctuation.sql` —
  no migration step remains. The Node normalizer is defined to mirror the column
  exactly so DB and script agree.
- The trigram index on `name_search` is **partial to approved artists only**.
  Fuzzy candidate lookup against *all* non-HÖR artists (any status) won't use
  it, so we either widen the query or compute similarity in Node. Given these
  run locally against a full table read, Node-side is fine.
- Per the 1000-row PostgREST cap, every table read paginates.
- No cache/marker files — the source of truth for "already processed" is
  `directory_status` itself (we only ever act on `pending`), which also makes
  re-runs idempotent.

---

## Normalization (shared helper)

`normalizeName(s)` = lowercase → strip diacritics (unaccent) → remove every
character that isn't `[a-z0-9]` (drops spaces **and** punctuation). This is the
key for exact-dup comparison and the base for fuzzy comparison.

It is **defined to match the DB's `name_search` expression exactly**
(`regexp_replace(lower(immutable_unaccent(name)), '[^a-z0-9]', '', 'g')`), so
the two agree character-for-character. That lets the exact-dup rule lean on
`name_search` for equality while still normalizing the HÖR-side names in Node.

---

## Components

Three scripts, one shared lib module:

1. **`report-hoer-internal-dupes.mjs`** — pre-run step, standalone report.
2. **`resolve-hoer-status.mjs`** — the main resolver (precedence pipeline).
3. **`apply-hoer-dupe-review.mjs`** — round-trip importer for the reviewed
   inferred-duplicate CSV.
4. **`lib/hoer-resolve.mjs`** — normalization, pronoun detection, bio/genre
   overlap, CSV read/write — shared and unit-tested.

All CSVs are written with a `YYYYMMDD-HHMMSS` stamp in the filename.

---

## Step 1 — HÖR-internal duplicate report (run first among the scripts, resolve manually)

HÖR's own site has dupes (e.g. `/artist/ayako-mori/` and
`/artist/ayako-mori-2/` look like the same person). We surface these **before**
any matching against the rest of the DB so they can be resolved by hand first.

`report-hoer-internal-dupes.mjs`:

1. Load the HÖR batch (artists with a `platform='hoer'` link), plus each one's
   HÖR bio and genre set.
2. Compare every pair within the batch:
   - name similarity on the normalized names (trigram / normalized
     Levenshtein), **and**
   - the same bio token-overlap + genre-overlap signals used in the inferred-
     duplicate rule below.
3. Emit `hoer-internal-dupes-<stamp>.csv`: one row per candidate pair
   (`artist_id_a`, `name_a`, `url_a`, `artist_id_b`, `name_b`, `url_b`,
   `name_similarity`, `bio_overlap`, `shared_genres`, evidence), sorted by
   confidence.

No status changes here — this is purely a worklist. We resolve these (merge /
mark `duplicate` by hand) and only then run the main resolver.

---

## Main resolver — precedence pipeline

For each `pending` HÖR artist, apply rules **in this fixed order** and stop at
the first that fires:

1. **Exact duplicate** → `duplicate`
2. **Inferred duplicate** → *hold for review* (no change; even if pronouns look
   eligible, a possible dup is held)
3. **Pronoun eligibility** → `approved` or `not_eligible`
4. **No rule fired** → stays `pending`

### Rule 1 — exact duplicate

- Compare `normalizeName(hoer.name)` against the `name_search` of **all DB
  artists except HÖR-loaded ones** (exclude any artist with a `platform='hoer'`
  link; also exclude `deleted`). Because `name_search` is the aligned normalized
  key, this is a direct equality match.
- Exactly one match → set `directory_status='duplicate'`, record the matched
  artist.
- **More than one** DB artist shares that normalized name → ambiguous. Do **not**
  change status; write the case to `hoer-exact-ambiguous-<stamp>.csv`
  (`artist_id`, `hoer_name`, `hoer_url`, and every colliding
  `matched_artist_id` / `matched_name`) for manual review.
- Zero matches → fall through to Rule 2.

### Rule 2 — inferred duplicate (review, never auto-applied)

Only for artists with no exact match that have a HÖR bio and/or HÖR genres.

1. **Candidate shortlist:** non-HÖR, non-deleted DB artists whose normalized
   name is *similar* (trigram / normalized-Levenshtein above a threshold — start
   ~0.55, tune). Keeps the expensive comparison to a small subset.
2. **Score each candidate** using the extra signals:
   - bio: cheap token/keyword overlap (lowercase, stop-word-stripped Jaccard)
     between HÖR bio and the candidate's bio,
   - genres: set overlap between HÖR genre tags and the candidate's genres.
3. If any candidate clears a **confidence threshold** (name similarity combined
   with bio and/or genre overlap — exact combining rule is a tuning knob),
   write the artist + its top candidate(s) to
   `hoer-inferred-dupes-review-<stamp>.csv`. **No status change.**
4. This is also where an artist that *would* be pronoun-eligible but is a
   possible dup gets parked — it goes to the review file and is **not** approved.

Review CSV columns (also the contract for the round-trip importer):
`artist_id` (HÖR, stable key), `hoer_name`, `hoer_url`, `matched_artist_id`,
`matched_name`, `name_similarity`, `bio_overlap`, `shared_genres`,
`proposed_status` (default `duplicate`), and a blank **`decision`** column for
Maisie to fill (`duplicate` / `approve` / `reject` / leave blank = skip).

### Rule 3 — pronoun eligibility

Runs only if no dup rule fired. Uses the HÖR bio (`biographies`, platform
`'hoer'`; fall back to `artist_harvested_bios.raw_bio`).

Detection:

1. Read the `pronouns` table; parse each `value` (e.g. `"she/her"`,
   `"they/them"`, `"she/they"`) into its component tokens to build a
   token → pronoun-set map.
2. Word-boundary, case-insensitive count of pronoun tokens in the bio.
3. **Dominant set** = the pronoun-table row with the most token hits.
   **Dominance ratio** = dominant hits ÷ total pronoun-token hits.

Decisions (dominance threshold = **0.80**; a single pronoun mention is enough):

- Dominant set is **not** `he/him` **and** ratio ≥ 0.80 → `approved`, set
  `pronoun_id` to the dominant set.
- Dominant set **is** `he/him` **and** ratio ≥ 0.80 → `not_eligible`, set
  `pronoun_id` to `he/him`.
- Ratio < 0.80, or no pronouns found → stays `pending`.

The ratio naturally protects mixed cases: a he/they bio splits its tokens, never
reaches 0.80 on `he/him`, and is left `pending` rather than wrongly marked
`not_eligible`.

Known false-positive risk (flagged for audit, not auto-corrected): bios often
mention *other* people (collaborators, label heads), and some HÖR bios are
non-English (German `sie/ihr`). The report records the matched pronoun tokens /
sentences so borderline calls are checkable; the exact detection wording is a
tuning knob for round two.

---

## Overarching run report

`resolve-hoer-status.mjs` writes one master CSV per run,
`hoer-status-resolution-<stamp>.csv`, containing **only the artists whose status
this run actually changed** (Rules 1 and 3). Columns:

`run_at`, `artist_id`, `hoer_name`, `hoer_url`, `rule` (`exact_duplicate` /
`pronoun_approved` / `pronoun_not_eligible`), `old_status`, `new_status`,
`assigned_pronoun`, `dominance_ratio` (populated for pronoun rows),
`matched_artist_id`, `matched_name`, `evidence`.

The review/ambiguous files (`hoer-inferred-dupes-review-*`,
`hoer-exact-ambiguous-*`, and the Step-1 `hoer-internal-dupes-*`) are separate —
they list artists that were **not** changed and need a human.

---

## Round-trip importer

`apply-hoer-dupe-review.mjs <reviewed.csv>`:

1. Read the reviewed inferred-duplicate CSV.
2. For each row with a non-blank `decision`, look up the artist by `artist_id`.
3. **Guard:** only update if the row is still `directory_status='pending'`
   (skip + log anything already changed, so a re-upload can't clobber a
   hand-edited status).
4. Apply: `decision=duplicate` → `duplicate`; `approve` → `approved`;
   `reject` → `rejected`; blank → skip.
5. Write `hoer-dupe-review-applied-<stamp>.csv` recording what was changed and
   what was skipped and why.

Because it keys on the stable `artist_id` and touches only rows present in the
uploaded file, the upload can safely be a filtered subset of the review output.

---

## Testing & rollout

- Unit tests (no DB) for `lib/hoer-resolve.mjs`: normalization, pronoun
  counting + dominance ratio (incl. the he/they edge case and the exactly-0.80
  boundary), bio/genre overlap, CSV round-trip.
- First live run: `--dry-run` (compute + write CSVs, no DB writes) so we can eye
  the reports before anything changes. Also confirm the actual `pronouns.value`
  strings match detection assumptions on this run.
- Then run for real; spot-check the master report against a few artist pages.

## Open tuning knobs (expected to need a second pass)

- Inferred-dup candidate-shortlist similarity threshold (~0.55 start).
- Inferred-dup confidence rule — how name similarity, bio overlap, and genre
  overlap combine into "confident enough to surface."
- Pronoun detection scoping (whole bio vs. sentences naming the artist) and
  non-English handling.
