# Documentation

All project documentation lives in this directory. New `.md` files go here
too — see [CLAUDE.md](../CLAUDE.md) at the repo root.

## Start here

| Doc | What it covers |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Project overview — schema, stack, conventions, current state |
| [OPERATIONS.md](OPERATIONS.md) | Operations & backend setup |
| [PIPELINE.md](PIPELINE.md) | The ordered enrichment pipeline, script by script |

## Subsystems

| Doc | What it covers |
|---|---|
| [GENRES.md](GENRES.md) | How genres are harvested, normalised and pruned |
| [GENRE_CONFIDENCE.md](GENRE_CONFIDENCE.md) | Genre confidence & corroboration scoring |
| [MATCHING.md](MATCHING.md) | External platform matching — the two pipelines |
| [ORGANISATIONS.md](ORGANISATIONS.md) | Record labels, clubs, crews and events as real entries — schema, backfill, admin panel, public pages and forms |
| [SCORING.md](SCORING.md) | Similarity scoring for recommendations |
| [REPORTS.md](REPORTS.md) | Admin reports and their download routes |
| [OUTPUT-FILE-LOCATION.md](OUTPUT-FILE-LOCATION.md) | Where generated `.csv`/`.ods` files are written, and by which script |

## Plans (accepted, in progress or done)

| Doc | What it covers |
|---|---|
| [HOER-SYNC-REWORK-PLAN.md](HOER-SYNC-REWORK-PLAN.md) | HÖR sync rework |
| [HOER-STATUS-RESOLUTION-PLAN.md](HOER-STATUS-RESOLUTION-PLAN.md) | HÖR pending-status resolution |
| [IMAGE-HARVESTING-PLAN.md](IMAGE-HARVESTING-PLAN.md) | Image harvesting — ownership & shared policy |
| [URL-RESOLUTION-PLAN.md](URL-RESOLUTION-PLAN.md) | URL redirect resolution |
| [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) | Recommendation engine improvements |
| [RECOMMENDED-ARTISTS-SIDEBAR-PATCH.md](RECOMMENDED-ARTISTS-SIDEBAR-PATCH.md) | Abandoned July sidebar work — **and the unrepaired `artist_similarity_scores` wipe that left recommendations dark in production** |

## Loose ends

| Doc | What it covers |
|---|---|
| [MISCELLANEOUS-TASKS.md](MISCELLANEOUS-TASKS.md) | Small jobs with no home of their own — currently the unprotected-uncommitted-work gap in the branch guards |

## Proposals (not accepted — decisions still open)

| Doc | What it covers |
|---|---|
| [PROPOSAL-platform-links.md](PROPOSAL-platform-links.md) | Paste-to-detect platform links |
| [PROPOSAL-provenance-purge.md](PROPOSAL-provenance-purge.md) | Platform-data provenance & cascading purge |
