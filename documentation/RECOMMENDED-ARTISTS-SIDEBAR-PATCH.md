# The recommended-artists-sidebar patch

> **What this is.** A record of abandoned work saved out of a stale git
> worktree on 2026-08-15, and — more importantly — of an unfinished
> production incident it left behind.
>
> **The patch:**
> `…/Rebalance Gender/output files/recommended-artists-sidebar-uncommitted-20260815.patch`
> (401 lines, 6 files, outside the repo).

## ⚠️ Read this first: recommendations are currently dark in production

The "You might also like" section is **missing from every artist page on the
live site**. Sampled 8 artist pages on `www.rebalance-gender.app` on
2026-08-15: 0 of 8 render the section. `RecommendedArtists` is an async
server component that returns `null` when the query comes back empty, so its
absence means `artist_similarity_scores` has no rows for those artists. The
rest of each page (SoundCloud bio, links) renders normally, so this is data,
not a rendering fault.

This traces to a botched write on 2026-07-19/20 (below) that cut the table
from **13,086 rows to 482** and was never repaired. It has been that way for
about four weeks.

**The fix is a single command** — the table is pure derived data, computed
from `artist_genres`, `mb_tags`, `collaborations` and `sc_follow_edges`, all
of which were untouched:

```bash
node scripts/compute-scores.mjs --force
```

`main`'s copy of the script caps at 10 and uses `upsert`, which matches the
still-current `rank <= 10` DB constraint, so a rebuild should just work.
Verify with a dry run first (`DRY_RUN=1 node scripts/compute-scores.mjs`) and
re-check an artist page afterwards.

## Where the patch came from

| | |
|---|---|
| Session | "Recommended artists layout redesign" (17–20 July 2026) |
| Worktree | `.claude/worktrees/recommended-artists-sidebar` |
| Branch | `worktree-recommended-artists-sidebar` |
| Base commit | `3b20af8` — "Merge pull request #17", 16 July 2026 |

The worktree still exists; only its 189 MB `.next` build output was deleted.
The patch is a snapshot of its uncommitted working tree, taken so the
worktree could be cleaned up later without losing the work.

## What the work was trying to do

Three strands, none merged:

**1. Move recommendations into the artist-page sidebar.** Previously a
full-width strip below the two-column layout; the patch moves
`<RecommendedArtists>` inside the `<aside>`, under the SoundCloud bio, and
makes the aside a `space-y-8` stack so the bio no longer has to be present
for the sidebar to exist. The grid narrows to a fixed 3 columns to suit the
column width, instead of the responsive 3→10 it uses on `main`.

**2. Raise the recommendation count from 10 to 12.** Touches four places in
lockstep: the `slice(0, 10)` in `compute-scores.mjs`, the `.limit(10)` in
`getRecommendedArtists`, its doc comment, and — separately — the `/api/discover`
result cap, which goes the *other* way, 20 → 12.

**3. Visual pass on the avatar cards.** Both `RecommendedArtists` and
`DiscoverResultsGrid` adopt the `avatar-ring` treatment used elsewhere,
grow to `h-24 w-24`, and give the letter fallback the `ff-display` font in
violet rather than grey.

Alongside those, real robustness fixes to `compute-scores.mjs` that are
arguably the most valuable part of the patch:

- **URL-length chunking.** The directory grew past 2,000 approved artists,
  and passing every ID in one PostgREST `.in(...)` / `.or(...)` filter built
  a URL long enough to be rejected. Adds `ID_CHUNK = 100` and a
  `fetchByIdBatches` helper. `loadScFollowEdges` can't chunk both sides, so
  it filters the followed side in JS against the directory set.
- **A schema-mismatch fix.** `loadArtistGenres` selected `artist_genres.genre`,
  but the column is `genre_id` — a genre FK, not a name.
- **`--force` actually rebuilding.** The header claimed `--force` truncates;
  the code only skipped the already-scored filter and upserted. Any artist
  that dropped out of the new top set kept a stale row, so a source could end
  up with more than the intended number of rows and colliding ranks.

## What went wrong

That last fix is what caused the incident. The new write path is
delete-then-insert per source artist:

1. `DELETE` the source's existing rows — succeeded
2. `INSERT` the new top-12 — **failed** on
   `artist_similarity_scores_rank_check`, a DB `CHECK (rank >= 1 AND rank <= 10)`

Every artist with 11 or 12 recommendations lost their old rows and gained
nothing. Only the 72 artists with ≤10 survived: 13,086 → 482 rows.

Raising the cap needs DDL, and the `SUPABASE_DB_URL` role is not the table
owner, so it can't `ALTER`. Migrations here are applied by hand in the
Supabase SQL editor. The session ended while writing that migration file, and
it was never written, never applied, and the table was never rebuilt.

Verified 2026-08-15 — the constraint is still capped at 10:

```
artist_similarity_scores_rank_check | CHECK (((rank >= 1) AND (rank <= 10)))
```

and `main` is still at 10 in `compute-scores.mjs`, `queries.ts` and the
`RecommendedArtists` grid. Nothing from this work reached `main`.

## If you want to revive it

The patch **will not apply cleanly**. Its base is ~69 PRs behind, and
`src/components/DiscoverResultsGrid.tsx` — one of the six files it
modifies — has since been deleted from `main`. Treat it as a design
reference to re-implement, not a patch to `git apply`.

Ordered by value:

1. **Rebuild the table** (above). Independent of everything else here, and
   the only item that affects the live site today.
2. **Port the `compute-scores.mjs` chunking and the `genre_id` fix.** These
   are correctness fixes against a directory that has only grown since. Worth
   checking whether `main`'s version still has both bugs before assuming.
3. **The 10 → 12 change** needs a migration relaxing the rank constraint
   *applied first*, then the four code changes together. Doing it in the
   other order reproduces the incident exactly.
4. **The sidebar layout and avatar restyle** are pure design decisions from
   July; re-decide rather than restore.

## Related

- [PIPELINE.md](PIPELINE.md) — where `compute-scores` sits in the pipeline
- [SCORING.md](SCORING.md) — how the similarity scores are computed
- [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) — recommendation engine plans
