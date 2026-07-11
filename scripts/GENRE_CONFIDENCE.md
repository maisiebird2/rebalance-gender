# Genre confidence & corroboration

A scheme for deciding *which* harvested genres to actually apply to an
artist, and *how much to trust* each one — so we can auto-accept the
reliable ones and route the doubtful ones to review instead of blindly
ingesting everything.

This sits **between** harvest and the live tables described in
`GENRES.md`:

```
harvest ──▶ [ score + corroborate ] ──▶ integrate ──▶ live tables
 (evidence)   (this document)            (auto-accept   (artist_genres)
                                          only)
                     └──▶ review queue ──▶ (manual accept/reject)
```

The vocabulary layer is unchanged: everything is still normalised
through `normaliseTag` / `GENRE_ALIASES` before it is scored, so
`dnb` and `drum & bass` corroborate each other rather than splitting.

---

## The problem this solves

The last.fm / MusicBrainz / Spotify harvests start from an artist
*name* and guess which entity it refers to. When the guess is wrong,
every genre from that match is wrong too — a whole error class baked in
before any tag is read.

SoundCloud and Bandcamp links are direct URLs to the real artist, so
their signals carry no matching risk. The scheme below encodes that
asymmetry: **a signal's trust depends on both where it came from and
how it was produced**, and doubtful genres are held for review rather
than dropped or blindly accepted.

---

## Two things every signal has

Each piece of evidence is scored on two independent axes, then
multiplied.

### 1. Source trust — can we believe this is the right artist at all?

| Tier | Sources | Multiplier | Why |
|---|---|---|---|
| Direct, self-owned | SoundCloud own uploads, Bandcamp own releases | **1.0** | Link resolves to the artist; content is theirs |
| Direct, third-party | Discogs styles, Beatport, Resident Advisor (on a confirmed link) | **0.8** | Right artist, but tags set by an editor/label, not them |
| Name-matched | last.fm, MusicBrainz, Spotify | **0.4** | Genre may be right, but the *artist match itself* is uncertain |
| Bio text | any harvested bio | **0.3** | Same artist, but mentions are often influences, not their genre |

### 2. Signal type — how genre-like is the datum itself?

| Signal | Weight | Notes |
|---|---|---|
| Structured genre field | **1.0** | SoundCloud `track.genre`, Bandcamp primary tag, Beatport genre |
| Self-applied free tag | **0.7** | SoundCloud `tag_list` — filter through `BROAD_TAGS` + `non-genre-hints` first |
| Editorial / community tag | **0.6** | last.fm community tags, Discogs styles |
| Bio mention | **0.5** | genre name found in bio via vocabulary match or LLM extraction |

A signal's base weight = `source_trust × signal_type`. So a genre on an
artist's own SoundCloud uploads scores `1.0 × 1.0 = 1.0`; the same word
appearing in a last.fm community tag scores `0.4 × 0.6 = 0.24`; a bio
mention scores `0.3 × 0.5 = 0.15`.

---

## Volume & consistency (per-track sources)

For sources that produce one signal *per track/release* (SoundCloud own
uploads, Bandcamp releases), a genre is far more convincing when it's
consistent across the catalogue than when it appears once.

Weight each such genre by its **prevalence** = share of the artist's own
items carrying it, with small-sample smoothing so a 1-of-1 doesn't look
like a 20-of-20:

```
prevalence = (items_with_genre + 0.5) / (total_items + 1)
```

Then that source's contribution = `base_weight × prevalence`. An artist
whose 20 uploads are all "melodic techno" contributes ≈1.0 for that
genre; a single stray "ambient" upload among them contributes ≈0.07.

Require **≥3 own items** before a per-track source can count toward
auto-accept on its own; below that, it can only *corroborate* (see
below). This keeps two-track accounts out of the auto lane.

---

## The score

For each `(artist, canonical_genre)` pair, sum the contributions of all
signals supporting it:

```
S = Σ ( source_trust × signal_type × prevalence )
```

Two derived quantities drive the decision:

- **S** — the total weighted evidence.
- **corroboration** — the number of *distinct sources* supporting the
  genre (SoundCloud, Bandcamp, Discogs, last.fm, bio … each counts
  once). Parent/child genres related by the `ROLLUP` map count as
  agreeing, not competing (techno + melodic techno → same vote).

---

## Decision rules

Applied per `(artist, genre)`, in order:

1. **Auto-accept** if either:
   - `S ≥ T_high`, **or**
   - `corroboration ≥ 2` from *distinct direct-link sources*
     (self-owned or third-party), regardless of S.
2. **Review queue** if `T_low ≤ S < T_high`, or the only support is a
   single non-direct source.
3. **Discard** if `S < T_low`.

Two hard floors that override the above:

- **Bio-only never auto-accepts.** A genre supported *only* by bio
  mentions goes to review at best, never straight to live.
- **Name-matched-only never auto-accepts.** last.fm / MB / Spotify
  signals can *boost* a genre toward a threshold or *corroborate* a
  direct signal, but on their own they can only reach the review queue —
  this is the rule that stops a bad last.fm match writing genres.

Per-artist guard: after ranking an artist's genres by S, only
auto-accept those within a ratio of the top score (e.g. `S ≥ 0.4 × S_top`)
so a confident primary genre doesn't drag a long tail of weak ones in
with it.

### Starting thresholds (to be tuned)

`T_high = 1.0`, `T_low = 0.3`. These are guesses — calibrate them
against a hand-labelled sample (see Validation) rather than trusting the
defaults. All weights and thresholds should live in one config object,
mirroring `tune-weights.py`, so calibration is a data exercise, not a
code edit.

---

## Worked examples

- **All 25 own SoundCloud uploads tagged "house."** One source,
  S ≈ 1.0, prevalence ≈ 1.0, ≥3 items → **auto-accept** on T_high even
  without a second source.
- **SoundCloud own tracks say "techno" (S≈0.9) and Bandcamp release
  tagged "techno" (S≈0.8).** Two distinct direct sources agree →
  **auto-accept** by the corroboration rule; combined S≈1.7.
- **Only a last.fm match says "deep house" (S≈0.24).** Name-matched
  only → **review queue**, never auto, even though the tag looks fine.
- **Bio says "influenced by jazz and dub" (S≈0.15 each).** Bio-only →
  **review** at most; likely **discard** under T_low.
- **Discogs style "electro" (S≈0.48) + bio mention "electro"
  (S≈0.15).** One direct source + one bio = corroboration of 2, but not
  *two direct* sources; S≈0.63 sits between thresholds → **review**
  (promotable if a SoundCloud signal later agrees).

---

## Where it lives (data model)

Keep `artist_harvested_genres` as the pure evidence log it already is,
and add the inputs scoring needs to each row:

- `signal_type` — structured / self_tag / editorial / bio
- `prevalence` — nullable; set for per-track sources
- (`source_platform`, `raw_tag`, `genre_id` already exist)

Add an aggregated **candidate** layer (new table, e.g.
`artist_genre_candidates`) holding one row per `(artist_id, genre_id)`
with:

- `score` (S), `corroboration`, `sources` (JSONB — the evidence behind
  it, for the review UI to explain *why*)
- `decision` — `auto` / `review` / `rejected` / `accepted`
- timestamps

Per project convention, all of this is written to the database, not a
cache file. Only `decision IN ('auto','accepted')` candidates are
promoted by `integrate-harvested-genres.mjs` into `artist_genres`;
`review` rows wait for a human.

---

## Review workflow

Mirror the existing `genre-report.mjs` → edit CSV →
`apply-genre-status.mjs` pattern:

1. A report lists `review` candidates with score, corroboration, and the
   `sources` evidence so the call is quick to make.
2. Reviewer sets each to accept/reject.
3. Apply writes the decision back to `artist_genre_candidates`; accepted
   ones flow through integrate on the next run.

An admin page could replace the CSV later, but the CSV path gets it
working with tooling that already exists.

---

## Validation & tuning

- Hand-label a sample of artists with their true genres.
- Measure **precision of the auto-accept lane** — the number that
  actually matters, since auto-accepted genres skip human review.
- Raise `T_high` until auto-accept precision clears a target
  (e.g. ≥95%); lower `T_low` only as far as review-queue noise stays
  manageable.
- Re-run whenever weights change; treat the weight/threshold table as
  the thing under calibration.

---

## Open questions

- Should Beatport / Resident Advisor be harvested at all yet, or is
  SoundCloud-own + Bandcamp enough to start and prove the scheme?
- Do we let a very strong single direct source (100% of a large
  catalogue) auto-accept a *second* and *third* genre, or cap auto to
  the single top genre and send the rest to review?
- How aggressively should the `ROLLUP` map fold subgenres before
  scoring vs. after — folding early boosts corroboration but loses
  specificity.
