# HÖR sync rework — implementation plan

Replacing the monolithic `sync-hoer.mjs` with four small, independently runnable
scripts driven by HÖR's **library of sets** rather than by its full artist
roster, and deferring artist creation until after socials-based matching.

Status: **plan only — nothing implemented.** Goes on a branch off `main`
(project rule). These scripts hit Supabase, so they're run locally.

---

## Why

`sync-hoer.mjs` is the most expensive member of the harvest loop and was
commented out of `harvest-links-loop.mjs` in `5448096` pending this rework. The
cost is not where it looks:

| Phase | Work | Cost per run |
|---|---|---|
| 0 — roster | Enumerate **9,954** `ppma_author` terms, 100/page @ 300 ms throttle | ~100 requests, **every run**, regardless of whether anything changed |
| 1 — sets | `posts?after=<cursor>` | already incremental — ~1 page/week |
| 2 — pages | Scrape `/artist/<slug>/` + WP user record for every unscraped artist | 2 requests × ~0.6 s, proportional to backlog |

Phase 0 is a **fixed** cost paid on every loop round to discover a handful of new
artists. The roster backfill has already been done by hand, so re-deriving it
each run buys nothing. What's needed is a lightweight *keep it current* path.

The second goal is new: **use HÖR's socials to avoid creating duplicates.** A
HÖR artist page listing a SoundCloud URL we already hold is the same person as
the artist who holds it — so bind the HÖR link onto the existing artist rather
than seeding a second row for them.

---

## Grounding — API facts verified live on 2026-07-22

All checked directly against `hoer.live`; the design leans on them, so re-check
if behaviour looks off.

| Fact | Value |
|---|---|
| `ppma_author` terms | 9,954 |
| `posts` (sets) | 9,565 |
| `tags` (genres) | 122 — 2 pages, cheap to read whole |
| Set volume | 136 posts / 30 d; 393 / 90 d; 1,654 / 365 d |
| Distinct authors | 139 / 30 d; 404 / 90 d; 1,587 / 365 d — HÖR barely repeats DJs, so authors ≈ posts |
| Multi-author sets | 7 / 30 d; 18 / 90 d (~5%) |
| `?after=` and `?modified_after=` | both supported on `posts` |
| `ppma_author?include=<ids>` | batch lookup works — 404 ids resolved in **5** requests vs 100 pages |

### The `authors` field — the finding this plan is built on

Each post carries a top-level **`authors`** array (PublishPress's expanded author
objects), present on 100/100 recent posts sampled:

```json
{
  "term_id": 14628, "user_id": 233733, "is_guest": 0,
  "slug": "gmoz", "display_name": "GMOZ",
  "first_name": "Georgia", "last_name": "Morrow",
  "user_url": "", "job_title": "",
  "description": "GMOZ is an Australian Producer/DJ focussing on …"
}
```

Consequences:

- **The artist URL is free from the post** — `https://hoer.live/artist/<slug>/`.
- **`description` is the complete bio.** Spot-checked against
  `/wp-json/wp/v2/users/233733` — byte-identical bar a trailing newline. The
  per-artist users-API call in today's Phase 2 becomes unnecessary. ~22% of
  authors have a non-empty one (23/103 sampled).
- **`display_name` is the stage name**, `first_name`/`last_name` the legal name.
- `is_guest` / `user_id` identify guest terms with no user archive.
- **`ppma_author.name` is NOT in this payload** — there is no `name` key. It is
  also not worth fetching. See "Name fields" below.

### Correction to a standing assumption

`sync-hoer.mjs`'s header states `ppma_author.name` is the artist's **legal**
name, and seeds `artist_legal_names` from it. That is wrong:

| term_id | `name` | actually |
|---|---|---|
| 14628 | `GMOZ` | stage name (legal name is Georgia Morrow) |
| 14883 | `Romsy1` | the **slug**, WP uniqueness digit included |
| 12361 | `Posi Flo` | stage name |

`artist_legal_names` has been accumulating stage names and slug junk. The new
design takes the legal name from `first_name` + `last_name`. **A cleanup pass
over existing `platform='hoer'` rows is needed** — scoped as a follow-up.

### Caveat on the DB figures

The read-only `SUPABASE_DB_URL` role is RLS-filtered and sees only `approved`
artists (781 HÖR links, 2,251 approved artists, 2,194 SoundCloud links). Any
`pending` / `rejected` / `duplicate` rows are invisible to it, so both "new to
us" counts and the socials match pool are understated. Verify with the service
key before sizing anything.

---

## The process

1. Get all HÖR sets from a certain date onward.
2. Determine which artists from those sets are new.
3. Get socials and images for those artists.
4. Compare socials against the database:
   - **4a — match** (e.g. the HÖR listing has a SoundCloud URL already held by
     an artist): add the HÖR artist URL to that artist's `artist_links`, if they
     don't already have a HÖR link.
   - **4b — no match**: create a new artist, `directory_status='pending'`.

Deduplication proper runs separately, outside
`orchestrate-platform-enrichment.mjs`.

### The ordering problem this creates

Artist creation now happens at step 4, but step 3 scrapes pages for artists that
have **no `artists` row yet** — while every table step 3 would write to
(`artist_images`, `artist_harvested_links`, `biographies`, `resolved_artists`)
is keyed on `artist_id`.

**Resolution: step 3 stages its output against `term_id`, not `artist_id`.**
Step 4 resolves identity and only then fans out into the live artist tables.
This is the repo's existing stage-then-integrate idiom (`artist_harvested_links`
→ `integrate-harvested-links.mjs`), applied one level earlier.

It follows that **bios and genres for new terms must also wait for step 4** —
they need an `artist_id` too. Terms already bound to an artist fan out
immediately in step 2. (Collaborations are not fanned out at all — see below.)

### Collaborations are derived, not stored

HÖR collaboration counts are **not** written to the `collaborations` table.
Every set is already in `hoer_sets` with its `term_ids`, so the number of
collaborations between two artists is a query over the ledger: map each artist
to its HÖR term(s) via `hoer_terms`, then count distinct `hoer_sets` whose
`term_ids` contain a term from both. The recommendation engine computes this on
demand (or via a view) when it needs it.

This removes the one stateful, non-idempotent write the old design had. There is
no counter to double-count when the deliberate rewind or a `modified_after`
sweep re-reads a set — the ledger is the single source of truth and the count is
a pure function of it. Neither Phase B nor Phase D touches `collaborations` at
all. (Other platforms — Discogs, MusicBrainz — keep their own rows there under
their own `source_platform`; HÖR simply stops contributing.)

---

## Architecture

Four scripts, one per numbered step:

| | Script | Does | Talks to |
|---|---|---|---|
| **A** | `harvest-hoer-library.mjs` | Ingest new/changed sets into a durable ledger | HÖR → `hoer_sets` |
| **B** | `seed-hoer-terms.mjs` | Map authors → terms; bind known ones and fan out their set data; register unknown ones as unbound candidates | `hoer_sets` → `hoer_terms` |
| **C** | `enrich-hoer-terms.mjs` | Scrape `/artist/<slug>/` for portrait + socials, staged by `term_id` | HÖR → `hoer_terms`, `hoer_term_links` |
| **D** | `integrate-hoer-artists.mjs` | Match socials → bind to existing artist or seed a new pending one; fan out everything | `hoer_terms` → live artist tables |

A knows nothing about our artists. B and C work in HÖR's identity space
(`term_id`). **D is the only script that creates or binds `artists` rows.**

---

## Phase A — `harvest-hoer-library.mjs`

Populates `hoer_sets`, the set ledger — the spine of the new system.

### Window selection

```
node scripts/harvest-hoer-library.mjs --from=2026-02-04   # explicit start (seeding)
node scripts/harvest-hoer-library.mjs                     # incremental
```

- `--from=<ISO date>` — crawl every post from that date forward. Seeds the table
  on first run, or re-covers a period.
- `--rewind-days=<N>` — same thing relative to `max(post_date)`, for when you
  want a wider sweep without working out a date.
- **No flag** — read `max(post_date)` from `hoer_sets`, **rewind 7 days**, crawl
  from there. The overlap is deliberate and generous: it guarantees coverage
  across the boundary without depending on `after` being exactly inclusive or on
  WP's zone-less local `date` strings lining up, and — more usefully — it gives
  the `modified_after` sweep a week-wide window in which to pick up sets that
  were tagged or re-credited after publication. At ~32 posts/week that costs one
  extra page.
- **No flag and `hoer_sets` empty** → error telling the operator to pass
  `--from`. Never silently crawl all 9,565 posts.

The rewind makes re-reading posts routine, so **every downstream write must be
idempotent** — see "What this fixes".

### Crawl

Two sweeps, both paginated, deduped by `post_id`:

1. `posts?after=<start>&orderby=date&order=asc` — new sets.
2. `posts?modified_after=<start>` — sets edited since. 4 of 20 recent posts had
   no tags at publish time and 178 posts were modified in the preceding three
   weeks, so tags and credits land *after* publication. Without this sweep those
   sets are read once, untagged, and never revisited.

`_fields=id,date,date_gmt,modified,modified_gmt,slug,link,title,content,excerpt,tags,ppma_author,authors`

### Writes — `hoer_sets` (new table)

| Column | Source | Note |
|---|---|---|
| `post_id` | `id` | PK — stable identity |
| `post_date`, `post_date_gmt` | `date`, `date_gmt` | cursor reads `post_date`, since that's what `after` filters on |
| `post_modified`, `post_modified_gmt` | `modified`, `modified_gmt` | |
| `set_url` | `link` | the set's own page |
| `set_slug`, `title` | | |
| `content`, `excerpt` | `content.rendered`, `excerpt.rendered` | retained — storage is small at 9,565 rows, and set descriptions sometimes name collaborators the `ppma_author` credits miss |
| `tag_ids` | `tags` | `int[]` |
| `term_ids` | `ppma_author` | `int[]` |
| `authors` | `authors` | `jsonb`, verbatim — includes `display_name`, `first_name`, `last_name`, `description` per author |
| `artist_urls` | derived | `text[]`, `…/artist/<slug>/` per author |
| `ingested_at`, `processed_at` | | `processed_at` null = Phase B hasn't consumed it |

Upsert on `post_id`; a re-read updates the row and **resets `processed_at` to
null when `post_modified` changed**, so B re-examines genuinely edited sets and
skips untouched ones.

`artist_urls` and `term_ids` are arrays because ~5% of sets are multi-author.
`authors` is kept as raw `jsonb` for the same reason the `hoer-artist` cache blob
exists: fields not extracted today can be mined later without re-crawling.

### Name fields

`first_name`, `last_name` and `display_name` are captured verbatim in
`hoer_sets.authors`, and written as explicit scalar columns on **`hoer_terms`**
(not `hoer_sets` — they're per-artist attributes, and a set-keyed table can't
hold scalar name columns when 5% of sets have two or more authors).

**`ppma_author.name` is deliberately not stored.** Measured across 308 terms:

| `term.name` is… | Share |
|---|---|
| identical to `display_name` | 280 (91%) |
| identical to the de-slugged slug | 287 (93%) |
| one or the other | 304 (**99%**) |
| neither | 4 (1%) |

All four exceptions argue against keeping it:

```
slug          term.name            display_name   first/last
kirk-mp3      Kirk.mp3             Kirk           — / —
rot-ton1      ROT.TON1             ROT.TON        — / —
andreasz      Andreas Vleugels     Andreasz       Andreas / Vleugels
thanila       Nathalie Dávila      THANILA        Nathalie / Dávila
```

Two are slug junk — `ROT.TON1` carries WP's uniqueness digit that `display_name`
correctly strips, making `term.name` the *worse* value. The other two are real
legal names that `first_name`/`last_name` **already hold**. In every case where
`term.name` diverges, the field actually wanted is one already in hand.

Dropping it removes the `include=` batch call from Phase B, which becomes pure
DB work with **zero network calls** in the normal case. `ppma_author?include=`
survives only as the fallback for a post missing its `authors` array.

**Coverage ceiling:** `first_name`/`last_name` are populated for only **29%** of
authors (90/308, always both or neither). That bounds HÖR legal-name coverage
going forward — accurate, but not broad.

### `hoer_sync_state` is retired

Its only job was `last_set_date`. The cursor now derives from `max(post_date)` in
`hoer_sets` — strictly better, since it can't drift out of step with what was
actually ingested. Nothing else reads the table (confirmed), so it is dropped
once A is live and the derived cursor has been checked.

---

## Phase B — `seed-hoer-terms.mjs`

Consumes `hoer_sets` rows where `processed_at is null`. Creates **no `artists`
rows** — that is D's job alone.

```
node scripts/seed-hoer-terms.mjs
node scripts/seed-hoer-terms.mjs --limit=50 --debug
DRY_RUN=1 node scripts/seed-hoer-terms.mjs
```

### Steps

1. Collect distinct `term_id`s across unprocessed sets.
2. Upsert a `hoer_terms` row per term from the `authors` payload — `slug`,
   `display_name`, `first_name`, `last_name`, `wp_user_id`, `is_guest`, `bio`,
   `last_seen_at`. New terms get `artist_id = null` (**unbound candidate**).
3. Fallback only: if a set's `authors` array is absent or empty (0/100 sampled,
   but don't assume), resolve those `term_id`s via `ppma_author?include=<ids>` in
   batches of 100. In the normal case this phase makes **no network calls at
   all** beyond the tag map.
4. **For terms already bound** (`artist_id` not null) — fan out set data now:
   - `artist_harvested_genres` — `raw_tag` lowercased/trimmed via a tag map
     (`/tags`, 122 terms, read once per run). Upsert on
     `artist_id,source_platform,raw_tag`, `ignoreDuplicates`.
   - Bio → `biographies` + `artist_harvested_bios` if not already present.
   (Collaborations are not written — they are derived from `hoer_sets` at query
   time; see "Collaborations are derived, not stored" above.)
5. **For unbound terms** — their genres and bio wait for identity. Nothing extra
   need be recorded: an unbound term is simply `hoer_terms.artist_id is null`,
   and when Phase D binds it, D re-reads that term's sets from `hoer_sets` to
   stage the genres/bio it couldn't stage here. No pending-work table needed.
6. Stamp `processed_at` on consumed `hoer_sets` rows.

### `hoer_terms` (new table)

`term_id` (PK) · `artist_id` (**nullable** — null = unbound candidate) · `slug` ·
`display_name` · `first_name` · `last_name` · `bio` · `wp_user_id` · `is_guest` ·
`image_url` · `scraped_at` · `bound_at` · `bind_method` · `first_seen_at` ·
`last_seen_at`

**Keyed on `term_id`, not slug.** WP slugs carry uniqueness suffixes
(`posi-flo-2`, `romsy1`, `ayako-mori-2`) and can change; the term id is stable.
Slug-as-identity is precisely the pathology the `hoer-status-resolution` work had
to clean up after — see `HOER-STATUS-RESOLUTION-PLAN.md`.

`bind_method` records how the artist was bound (`social_match` / `seeded_new` /
`backfill`), which makes D's decisions auditable after the fact.

Binding this table to existing HÖR-linked artists is a one-off `--backfill-terms`
mode (not a fifth script): match `artist_links.handle` → `hoer_terms.slug`, set
`artist_id`, `bind_method = 'backfill'`, then replay those terms' sets from
`hoer_sets` to stage the genres/bio that couldn't be staged while they were
unbound. Duplicate-slug collisions (a slug on >1 artist — 3,672 of them in the
current data) are logged and left for the dedup process, never force-bound.
Terms bound this way still need `scraped_at` left null so Phase C harvests their
socials.

### Idempotency

Every write Phase B makes is idempotent, so the deliberate rewind and
`modified_after` re-reads are safe:

- `hoer_terms` upserts carry only identity/name/bio fields, never the binding
  columns, so re-seeding a term refreshes its names and bumps `last_seen_at`
  without disturbing an `artist_id` Phase D set.
- `artist_harvested_genres` upserts with `ignoreDuplicates`.
- Bio upserts on `(artist_id, platform)`.

The old design's one non-idempotent write — `collaborations.collab_count`,
incremented per shared set and reliant on the cursor never looking back — is
gone entirely, because collaborations are now derived from the ledger rather
than counted into a table (see above). `processed_at` is therefore just Phase
B's work queue and progress marker, not a correctness guarantee for any counter.

---

## Phase C — `enrich-hoer-terms.mjs`

The only HTML scrape, and the only per-artist network cost.

```
node scripts/enrich-hoer-terms.mjs                # every term with scraped_at null
node scripts/enrich-hoer-terms.mjs --limit=200
node scripts/enrich-hoer-terms.mjs --approved --force --name=… --debug
DRY_RUN=1 node scripts/enrich-hoer-terms.mjs
```

**Runs for every unscraped term, bound or unbound** — no default restriction to
the current batch. With the library kept current there is no large backlog, and
socials are needed for *all* new terms before D can match them.

`--limit=N` bounds a run (named for consistency with the other sync scripts).
`--approved` restricts to terms already bound to an approved artist; unbound
candidates are never gated by it, since discovering new artists is the point.

### Scope: portrait and socials only

Everything the old Phase 2 scraped is otherwise already in hand — verified
2026-07-22:

| Field | Now from | Evidence |
|---|---|---|
| Stage name | `authors[].display_name` | identical to page `<h1>` on **12/12** sampled — the `<h1>` read is dropped |
| Bio | `authors[].description` | byte-identical to `/users/<id>.description` |
| Legal name | `authors[].first_name/last_name` | structured, unlike `term.name` |
| Genres | `tags` | Phase B |
| Collaborations | `term_ids` in `hoer_sets` | derived at query time |
| **Portrait** | **page scrape** | 8/24 sampled pages (33%) |
| **Socials** | **page scrape** | 8/24 sampled pages (33%), mean 1.1 links |

Neither remaining field is reachable via the API: post `acf` is empty,
`featured_media` is `0`, the full `ppma_author` term object carries no `meta` or
`acf`, and `authors[].user_url` was empty on all 103 authors sampled.
`avatar_url` is a shared default placeholder, not a portrait.

*Caveat on the 33% figures:* the sampling regex tried only one of the two
`artist__image` attribute orderings `parseArtistPage` handles, so portrait
coverage may be understated. Re-measure with the real parser.

### Writes — staged by `term_id`

Reuses today's verified `parseArtistPage` selectors.

- **socials** → `hoer_term_links` (new): `term_id`, `raw_url`, `parsed_platform`,
  `parsed_url`, `discovered_at`. Classified through the shared
  `classifyPlatformUrl` + `CLASSIFY_CONFIGS.hoer` (already skips HÖR self-links
  and YouTube) and normalized with the existing `normalizeUrl`.
- **portrait** → `hoer_terms.image_url`
- **cache blob** → `api_response_cache`, namespace `hoer-artist`, key = slug
- `hoer_terms.scraped_at` stamped on success

Convergence state is `hoer_terms.scraped_at` — set on success, and also on a
definitive 404 (a dead/guest page, so we converge rather than retry forever). A
transient fetch failure leaves `scraped_at` null so the next run retries. Neither
`resolved_artists` nor `harvest_failures` can key an unbound term (both require
an `artist_id`, which most terms lack during a rebuild), so `scraped_at` is the
universal signal; `harvest_failures` (`service='hoer-sync'`) is written only as
an audit for the minority of terms already bound to an artist, and cleared on
their success. `resolved_artists` stays the convergence state for artists bound
in Phase D, for consistency with the other harvesters.

---

## Phase D — `integrate-hoer-artists.mjs`

The only script that creates or binds `artists` rows. Operates on `hoer_terms`
where `artist_id is null and scraped_at is not null`.

```
node scripts/integrate-hoer-artists.mjs
node scripts/integrate-hoer-artists.mjs --limit=100
DRY_RUN=1 node scripts/integrate-hoer-artists.mjs
```

### 4a — socials match

For each unbound term, take its `hoer_term_links` rows and look for an existing
`artist_links` row with the same `(platform, normalized url)`.

**Exclude non-identifying URLs (learned from real Phase C output).** HÖR pages
carry bare platform homepages (`https://bandcamp.com/`, `https://soundcloud.com/`
with no handle) and occasionally malformed hrefs. A bare host would match every
artist who has the same junk link, so the match MUST require a meaningful path
(a handle / id segment), not just host equality. Drop any candidate whose
`parsed_url` has an empty or `/`-only path before matching. (Phase C stages these
faithfully — filtering is a match-quality decision that belongs here in D.)

**Match pool.** Restrict to identity-bearing platforms — `soundcloud`,
`instagram`, `bandcamp`, `resident_advisor`, `discogs`, `spotify`. Excluded:

- `other` — 1,119 rows, generic by definition.
- `youtube` — already skipped by `CLASSIFY_CONFIGS.hoer`; HÖR set videos are not
  an artist-channel signal.
- `linktree` — usually per-person, but it is an aggregator and sometimes belongs
  to a collective or label. A false bind is worse than a duplicate here, since
  the standing dedup process catches duplicates and nothing catches a wrong
  bind. Revisit if the match rate proves too thin.

Outcomes:

**Binding never touches `directory_status`.** A bind adds a link and nothing
else; the matched artist keeps whatever standing it already had, and a newly
seeded one stays `pending`. Deciding who belongs in the directory is a separate
process — many HÖR artists are men and don't qualify for inclusion at all, so
inferring status from "appeared on HÖR" would be actively wrong.

| Case | Action |
|---|---|
| Exactly one artist matched | **Bind.** Set `hoer_terms.artist_id`, `bind_method='social_match'`. Insert `artist_links` `platform='hoer'` with the HÖR URL + slug **if the artist has no HÖR link**. |
| Matched artist already has a *different* HÖR link | **Conflict.** `artist_links_artist_platform_unique (artist_id, platform)` permits only one. Do not force. Bind the term, log to `hoer-bind-conflicts-<stamp>.csv`. |
| More than one artist matched | **Ambiguous.** No bind, no seed. Log to `hoer-bind-ambiguous-<stamp>.csv` and leave for the separate dedup process. |
| No match | → 4b |

### 4b — seed new

- Insert `artists`: `name = display_name`, `directory_status = 'pending'`.
- Insert `artist_links` `platform='hoer'`, `url = …/artist/<slug>/`,
  `handle = slug`.
- Set `hoer_terms.artist_id`, `bind_method='seeded_new'`.

### Fan-out (both paths, once `artist_id` exists)

- `artist_legal_names` `platform='hoer'` — from `first_name` + `last_name`,
  **only if non-empty**. Never from `term_name`.
- `biographies` + `artist_harvested_bios` `platform='hoer'` — from the term bio.
- `artist_images` `platform='hoer'` — from `hoer_terms.image_url`
  (`store-images.mjs` re-hosts).
- `artist_harvested_links` `source_platform='hoer'` — promote the term's
  `hoer_term_links` rows now that they have an owner.
  `integrate-harvested-links.mjs` then promotes them into `artist_links` as
  usual.
- `artist_harvested_genres` — replay the term's sets from `hoer_sets` (that's why
  B leaves unbound terms' genres unstaged). Collaborations need no replay — they
  are derived from `hoer_sets` at query time, so a newly bound term's sets count
  automatically once its `hoer_terms.artist_id` is set.
- `resolved_artists` `service='hoer-sync'`.

### Expected yield

Only ~33% of artists have any socials, so **roughly two-thirds of new terms will
have nothing to match on and go straight to 4b.** The match step is a partial
filter, not a comprehensive one — real value on the third that does carry a
social, especially SoundCloud (the largest link pool we hold), with the standing
dedup process still the backstop.

---

## Orchestration

**A → B → C → D as a stage group inside `orchestrate-platform-enrichment.mjs`,
before `harvest-links-loop.mjs`**, replacing the commented-out `sync-hoer.mjs`
entry in `harvest-links-loop.mjs`'s `HARVESTERS`.

Placed before the loop rather than inside it: only D produces something the loop
consumes (`artist_harvested_links`), and its input is fixed before the loop
starts — it cannot grow mid-loop the way a Bandcamp or Linktree target set does.
Running the group once up front and letting round 1's
`integrate-harvested-links` promote those socials gives downstream harvesters the
same inputs at a fraction of the cost.

Each script still runs standalone. `--approved` is meaningful only to **C**
(restrict enrichment of already-bound terms to approved artists; unbound
candidates are always scraped). **D ignores it** — binding and seeding are
discovery, never gated — so forwarding it to D is harmless but does nothing.

---

## Cost

| | Today (per loop round) | Proposed (per run) |
|---|---|---|
| Roster enumeration | ~100 requests | **0** |
| Library read | ~1 page | ~1–2 pages (two sweeps) |
| Author resolution | — | **0** — `authors` is inline on every post |
| Tag map | ~2 pages | ~2 pages |
| Per-artist scrape | 2 requests × unscraped backlog | 1 request × new terms (~5/day, ~30/week) |

A daily run is a handful of requests. The 100-request floor is gone.

---

## Migrations

- `supabase_migration_hoer_library.sql` — `hoer_sets`, `hoer_terms`,
  `hoer_term_links`. Internal state: RLS on, no anon/authenticated read policy,
  `service_role` grant only — same posture as `resolved_artists` /
  `harvest_failures` / `hoer_sync_state`. Idempotent
  (`CREATE TABLE IF NOT EXISTS`).
- `supabase_migration_drop_hoer_sync_state.sql` — after A is live and the cursor
  is confirmed to derive correctly from `hoer_sets`.

---

## Rollout

1. Migrations.
2. `harvest-hoer-library.mjs --from=<date>` under `DRY_RUN=1`, then for real.
   Pick the date far enough back to cover every existing artist's sets, so the
   slug-match backfill in step 4 can find them. (HÖR's full archive is only
   ~9,565 posts / ~17 pages — a full seed is cheap.)
3. `seed-hoer-terms.mjs` under `DRY_RUN=1`, then for real; check candidate counts
   and a sample of stage/legal name splits against live pages. This populates
   `hoer_terms` (all unbound).
4. `seed-hoer-terms.mjs --backfill-terms` to bind existing HÖR-linked artists by
   matching `artist_links.handle` → `hoer_terms.slug`. Verify the match rate
   before proceeding — unmatched rows mean either slug drift or (mostly) artists
   whose sets predate the seeded window, and duplicate-slug conflicts are left
   for the dedup process, not force-bound.
5. `enrich-hoer-terms.mjs --limit=20` as a smoke test, then unbounded.
6. `integrate-hoer-artists.mjs` under `DRY_RUN=1` **first** — this is the step
   that writes `artists` rows, and the match rate is the number to eyeball before
   letting it run for real. Check the ambiguous and conflict CSVs.
7. **Purge-and-rebuild the pending HÖR-only backlog** (decided 2026-07-22).
   Validate the full A→B→C→D rebuild on a small sample first (delete ~50, rerun,
   confirm they return cleanly and de-duplicated), THEN hard-delete the pending,
   non-deleted artists whose only link is HÖR and let the pipeline rebuild them.
   See "Purge-and-rebuild" below. Only after C and D exist and are proven.
8. Wire the group into `orchestrate-platform-enrichment.mjs`; delete
   `sync-hoer.mjs` and its commented-out `HARVESTERS` entry.
9. Follow-up (separate branch): clean up `artist_legal_names` rows where
   `platform='hoer'` that hold stage names or slugs.

### Purge-and-rebuild the pending HÖR-only backlog

The old roster-first `sync-hoer` seeded a large, duplicated backlog: **13,613
`artist_links` rows on ~9,937 HÖR slugs, 3,672 of those slugs claimed by more
than one artist**. Rather than carefully bind the new term identity onto those
messy rows, we delete the low-value subset and let the term-keyed pipeline
rebuild it clean.

- **Target: 3,297** — pending, non-deleted artists whose ONLY link is HÖR
  (measured 2026-07-22 via the service role; the RLS-limited read sees only the
  785 approved and badly undercounts). Cleanly bounded: 0 of them have a
  non-HÖR link, 0 have a `pronoun_id`, and their promoted `artist_genres` count
  is 0 — nothing curated or human-reviewed is lost. All attached data
  (harvested genres 6,561, bios 165, images 281, harvested socials 993) is
  HÖR-derived and reconstructed by A/B/C.
- **Not touched:** approved (785), duplicate (3,714), rejected (2,390),
  sc_followee (3,086), not_eligible (303) — they keep their HÖR links and are
  bound by `--backfill-terms` / Phase D.
- **Method: hard delete + dated backup table.** A soft delete (`deleted=true`)
  would leave the HÖR `artist_links` in place, keeping the slugs claimed so the
  rebuild can't run clean — so it must be a real delete (cascades to
  links/bios/images/harvested rows), preceded by backing the target rows up into
  a dated table. `hoer_terms.artist_id` is `ON DELETE SET NULL`, so any bound
  term reverts to an unbound candidate automatically and Phase D re-seeds/rematches it.
- **Sequencing (decided):** build C and D, validate the rebuild on a ~50-artist
  sample, then run the full delete + rebuild. Never before the rebuild path is proven.

## Testing

- Unit tests, no DB, mirroring `lib/hoer-resolve.test.mjs` /
  `lib/hoer-links.test.mjs`: window selection (explicit `--from`, rewind from
  max, empty-table error); `authors` → term-row shaping incl. empty
  `first_name`/`last_name` and guest terms; `artist_urls` derivation for
  multi-author sets; tag normalization; and **D's decision table** — one match,
  multiple matches, zero matches, matched-artist-already-has-a-HÖR-link.
- Idempotency test with real weight: run A twice over an overlapping window and
  B twice over the result, and assert the genre staging and `hoer_terms` bindings
  are unchanged by the second pass (no duplicate rows, no disturbed `artist_id`).
- D re-run safety: running D twice must not create a second `artists` row for the
  same term (guarded by `hoer_terms.artist_id` becoming non-null).
