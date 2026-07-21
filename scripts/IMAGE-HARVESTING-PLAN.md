# Image harvesting — ownership & shared policy plan

Give every platform exactly one owner for image acquisition, make that ownership
legible to whoever runs the scripts, and move the decisions all the owners share
into a single module. Coverage must not regress: the current 3,621 stored images
across 12 platforms all keep a path.

Status: **all five phases implemented.** Phase 3 landed in PR #32; Phases 0, 1,
2 and 4 followed. Two verification checks are still deliberately deferred (see
"Deferred checks").

One deviation from the plan as written: Phase 2 said to delete
`DEDICATED_HARVEST_PLATFORMS` entirely. It was renamed
`OWNED_BY_DEDICATED_HARVESTER` and kept instead — the refined rule (scrape an
owned platform only after its owner fails transiently) still needs to know which
platforms have an owner. The original "delete it" reasoning assumed the scrape
would never touch those platforms at all.

---

## The problem

Image acquisition lives in five scripts with no shared contract, and each
re-implements the same surrounding decisions: eligibility, link/`not_found`
handling, "already covered?", re-fetch on link change, placeholder rejection,
failure recording, dry-run. That duplication is why the SoundCloud overlap went
unnoticed — there was no single place where "who owns SoundCloud images?" was
answerable.

Concretely, today `soundcloud` and `bandcamp` have two writers each:

| Platform | Rows from dedicated harvester | Rows from `enrich-images` |
|---|---|---|
| soundcloud | 1,907 | 193 |
| bandcamp | 579 | 162 |

(Attributable because only `enrich-images` writes `source_page_url`.)

---

## End state

| Platform | Owner | `scrape-images` role |
|---|---|---|
| soundcloud | `sync-soundcloud.mjs` — SoundCloud `/resolve` API | only after a recorded **transient** failure |
| bandcamp | `sync-bandcamp.mjs` — page sidebar | only after a recorded **transient** failure |
| linktree | `sync-linktree.mjs` | only after a recorded **transient** failure |
| hoer | `sync-hoer.mjs` | only after a recorded **transient** failure |
| spotify, lastfm, apple_music, wikipedia, qobuz, resident_advisor, beatport, youtube | `scrape-images` | **sole owner** — fills any gap |
| discogs | none | currently yields zero images; decide whether to keep as a candidate |

Note the category is "has a dedicated harvester", not "has an API" — only
SoundCloud is genuinely API-based. Bandcamp, Linktree and HÖR are dedicated
*scrapers*. The ownership rule is the same for all four.

### Assumption that needs confirming

The "only run after a transient failure" rule applies **only to the four
platforms with a dedicated harvester**. For the eight scrape-only platforms,
`scrape-images` remains the sole path and must run on any gap.

Applied literally to all platforms, the rule would disable those eight and
strand **1,450 images across 919 approved artists** — there is no API path that
could have failed, so no artist would ever qualify. Flagging explicitly because
misreading this is the one way this plan causes real damage.

---

## Phase 0 — unify the failure vocabulary

A prerequisite, not a nicety: the "only after a transient failure" rule cannot be
expressed until failures are queryable in one shape.

Today a missing image can be recorded as any of:

| Service key | Written by | Statuses |
|---|---|---|
| `soundcloud-sync` | sync-soundcloud (main pass) | link/resolve failures |
| `image-sync:soundcloud` | sync-soundcloud (image-only pass) | `no_avatar`, `default_avatar`, `write_failed` |
| `image-enrich:<platform>` | enrich-images | `no_og_image` |

Collapse to one key per platform — `image:<platform>` — with a shared status set
that explicitly classifies each outcome as **definitive** (no image exists; never
retry without `--force`) or **transient** (unknown; retry, and eligible for
scrape fallback).

**Do this first.** `harvest_failures` is currently **empty (0 rows)**, so the
migration is free right now and gets more expensive with every run.

---

## Phase 1 — extract the shared policy module

New module (suggested `src/lib/images/policy.ts`) owning every decision that is
not platform-specific:

- eligibility — approved-only, `deleted = false`
- link resolution, including `not_found` and null-url rows
- the "already covered" test, and re-fetch on link change
- placeholder rejection
- the `artist_images` upsert shape (`source_url`, `source_page_url`, `fetched_at`)
- failure recording in the Phase 0 vocabulary
- dry-run and rate limiting

Callers: `scrape-images` and each sync script. Each keeps its own *acquisition*
code — that part is genuinely platform-specific — and delegates the decisions.

Fold the two placeholder rules into one registry keyed by platform:
`isDefaultAvatarUrl` (SoundCloud's grey default, currently in `sync-soundcloud`)
and `isPlaceholderImageUrl` (the Last.fm hash, currently in the lib). Today the
API path treats SoundCloud's grey placeholder as a failure while a scrape would
store it as a real photo; one registry closes that gap.

Behaviour-identical phase. Verify by running each script with `--dry-run` before
and after and diffing the intended writes.

---

## Phase 2 — rename and narrow `scrape-images`

- `enrich-images` → `scrape-images`, in both `src/lib/` and `scripts/`
- **Renamed `DEDICATED_HARVEST_PLATFORMS` to `OWNED_BY_DEDICATED_HARVESTER`**
  (the plan originally said delete it; see the deviation note above). The
  `hadImage && isDedicated` guard — the source of the original bug — is gone,
  replaced by a rule that reads the owner's recorded failure instead of
  inferring ownership from whether an image happens to exist.
- New gate, in order: skip if an image exists; skip if a **definitive** no-image
  result exists from any source; for the four dedicated platforms, additionally
  require a recorded **transient** failure before scraping.
- Keep this session's `fetchOgImage` fixes (tags found in `<body>`, empty-tag
  reported distinctly) — as the shared scrape path they now benefit every
  platform.

---

## Phase 3 — stop the form paths from scraping dedicated platforms

Three web-app paths currently call `enrichArtistImages` via `after()`:

| Path | File |
|---|---|
| quickApprove | `src/app/admin/actions.ts:34` |
| artist link edits | `src/app/artist/[id]/edit/actions.ts:362` |
| missing-links admin | `src/app/admin/missing-links/actions.ts:68` |

A newly approved artist has no images by definition, so today these scrape
SoundCloud immediately — before any API sync could have run. That inverts the
intended ordering on exactly the artists it matters most for.

**Change:** scope these calls to the scrape-only platforms, using the
`allowedPlatforms` option that already exists (`missing-links` uses it today).
Newly approved artists still get immediate Spotify/Wikipedia/YouTube coverage;
the dedicated platforms wait for their own script.

**No new trigger is needed.** `sync-soundcloud` already self-detects this case:
approved, `resolved_artists` has a `soundcloud-sync` row, no `soundcloud`
`artist_images` row → routed through `syncArtist({ imageOnly: true })`. State
lives in the DB, so the next orchestrator run picks the artist up with no queue
and no form-side wiring.

The only thing a form-side trigger would buy is immediacy, and it is not cheap:
`sync-soundcloud.mjs` is a standalone CLI (reads `.env.local` from disk, builds
its own client, writes CSV reports outside the repo) and can't be invoked from
the Next.js runtime as-is. Getting there means extracting its single-artist core
into a lib function — the same shape `enrichArtistImages()` already has relative
to `scripts/enrich-images.ts`. Worth doing eventually, deliberately out of scope
here.

---

## Phase 4 — orchestrator integration

Add `scrape-images` as a **final stage, after `harvest-links-loop`** — outside
the loop, not inside it. The loop converges by discovering new links across
rounds and filling images via each harvester; scraping inside it would race the
pipeline and fill gaps a later round would have covered properly. After
convergence the gap set is stable and genuinely means "the owners are done and
these are still uncovered."

Operator-facing:

- `--list` prints the ownership table above — platform, owner, scrape role, and
  whether required credentials are present
- `--platform=<name>` scopes a run
- the run summary reports per platform, distinguishing "scraped" from "skipped,
  owned elsewhere"
- `--approved` is forwarded to every stage by the orchestrator but is a no-op
  here (`scrape-images` is unconditionally approved-only); the help text should
  say so rather than imply it does something

---

## Deferred checks

Both deliberately postponed; neither blocks Phases 0–1.

1. **Bandcamp source agreement** — does `sync-bandcamp`'s sidebar image match the
   page's `og:image`, or is the latter an album banner? Both writers upsert the
   same key, so today the winner is decided by run order rather than policy. If
   they differ, Phase 2 needs explicit precedence.
2. **SoundCloud grey placeholder** — does it appear in `og:image`, or as the
   empty tag we already observed? Determines whether Phase 1's placeholder
   registry needs a SoundCloud entry for the scrape path.

SoundCloud's API and scrape are otherwise confirmed to agree: `og:image` is
populated exactly when an avatar exists.

---

## Out of scope

- The provider/strategy runner sketched earlier — rejected in favour of this
  simpler ownership split
- `store-images.mjs` and the two prune scripts — they operate on stored rows, not
  sources, and are orthogonal
- `src/lib/artist-images.ts` display rotation — this plan changes how rows are
  written, not how they're chosen

---

## Risks

| Risk | Mitigation |
|---|---|
| Misreading the scope of the "transient only" rule strands 1,450 images | Called out above; Phase 2 gate is written per-category, not globally |
| Scraped placeholder stored as a real photo | Phase 1 placeholder registry; deferred check 2 |
| Newly approved artists wait for the next orchestrator run for SoundCloud/Bandcamp images | Accepted; scrape-only platforms still land immediately via Phase 3 |
| Failure-vocabulary migration cost grows | Do Phase 0 first, while `harvest_failures` is empty |
