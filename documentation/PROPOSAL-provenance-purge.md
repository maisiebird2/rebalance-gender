# Proposal — platform-data provenance & cascading purge

> **Status: proposal, not accepted.** Written 2026-07-30 from a design
> discussion. Nothing here is built. Several design decisions **were**
> made in that discussion and are recorded as settled (see
> [Decisions already made](#decisions-already-made)); the open questions
> at the end are what remains to evaluate before building.

---

## The problem

Sometimes an incorrect platform link gets attached to an artist. Fixing
the link is easy; cleaning up everything the bad link *produced* is not:

- **Only images are pruned today**, and only when a platform's link is
  **removed entirely** ([actions.ts §7b](../src/app/artist/[id]/edit/actions.ts)).
  If a wrong SoundCloud URL is *replaced* with the right one in a single
  edit, the platform survives the save and nothing is pruned — the wrong
  profile's image, bio, and genres all stay.
- **Genres have no provenance.** The staging table
  (`artist_harvested_genres`) records `source_platform`, but
  [integrate-harvested-genres.mjs](../scripts/integrate-harvested-genres.mjs)
  promotes into `artist_genres (artist_id, genre_id)` with
  `ON CONFLICT DO NOTHING` — the source is dropped at the door. There is
  no way to delete "the genres that came from SoundCloud."
- **Harvested links have no provenance either.** Same pattern:
  `artist_harvested_links` carries `source_platform`/`source_url`, but
  [integrate-harvested-links.mjs](../scripts/integrate-harvested-links.mjs)
  inserts just `{artist_id, platform, handle, url}`. So if a wrong
  SoundCloud bio contributed an Instagram link, nothing records that the
  Instagram link — and everything later harvested *from Instagram* — is
  downstream of the bad SoundCloud URL.
- **The one invalidation mechanism that exists is dead on the main
  path.** `trg_artist_links_url_change`
  ([supabase_migration_follow_graph_tracking.sql](../migrations/supabase_migration_follow_graph_tracking.sql))
  clears `follow_graph_built_at` on `UPDATE OF url` — but the edit save
  path does delete-all-then-reinsert of `artist_links`
  ([actions.ts:301](../src/app/artist/[id]/edit/actions.ts)), which never
  fires an UPDATE trigger.

Goal: removing **or changing** a platform link purges everything derived
from that platform — images, bios, genres, enrichment, downstream
computed data, and links harvested from it (transitively) — without
touching human-entered data, and without new recompute machinery.

**Scope note:** Last.fm data is excluded from this plan — it is being
removed from the database independently.

---

## Decisions already made

Settled in the design discussion; not open questions:

1. **No synthetic link IDs.** Provenance keys on `(artist_id, platform)`
   and source *labels*, not link-row IDs (see
   [Alternatives considered](#alternatives-considered)).
2. **Incoming follow edges are deleted and stay gone** until the
   follower artists are next re-processed. The temporary recommendation
   degradation for a handful of artists is accepted.
3. **The dead trigger is removed** once the app-level purge lands, not
   kept as a backstop.
4. **No corroboration machinery.** The case where a link harvested from
   the bad profile is *also* genuinely correct (same Instagram URL
   listed on a correct Bandcamp page too) is judged too unlikely to
   build around. The purge deletes the whole doomed subtree
   unconditionally. Mitigating note: staging candidates from
   *non-doomed* sources are never deleted, so if the case ever occurs,
   the next `integrate-harvested-links` run re-promotes the link from
   the surviving candidate — the system heals without dedicated logic.

---

## 1. The provenance model

### Key: `(artist_id, platform)` — no link IDs

An artist has at most one link per platform, so the platform name *is*
the link's stable identity — and it is already the key nearly every
derived table uses: `artist_images` PK, `biographies` unique constraint,
`artist_enrichment` rows, `harvest_failures` service strings,
`artist_harvested_genres.source_platform`. A synthetic link ID would add
indirection without information, and would actively fight the save
path: delete-all-reinsert mints new IDs on every save, so FK-based
cascades would wipe derived data on every ordinary edit.

### `artist_links.source` — provenance for links themselves

New column `source text NOT NULL`, values:

| Value | Meaning | Purge behavior |
| --- | --- | --- |
| `submission` | From the public submit form | **Protected** — never auto-purged |
| `manual` | Added/edited by a human in the edit form | **Protected** |
| `unknown` | Pre-backfill rows that can't be attributed | **Protected** (err toward under-deletion) |
| `harvest:<platform>` | Parsed from that platform's bio/page | Purged when `<platform>` is purged |
| `hoer` (etc.) | Bulk-integration sources | Purgeable per-source if ever needed |

This makes link provenance a tree rooted at trusted entries, with
harvested links as children of the platform they were parsed from.

**Backfill:** match existing `artist_links` rows against
`artist_harvested_links` (`artist_id` + platform + `urlsMatch`) →
`harvest:<source_platform>`; everything unmatched gets `unknown`.
Wrong-direction backfill errors then err toward keeping data, which a
later manual purge can correct — over-deletion can't be undone.

**Promotion change:** `integrate-harvested-links.mjs` writes
`source: 'harvest:' + source_platform` instead of dropping it.

### `artist_genres.source` — per-source genre claims

Genres differ from images/bios: one genre can be claimed by several
sources (Spotify *and* MusicBrainz both say "techno"), plus manual
entry. So deletion must be per-claim, not per-genre.

- Add `source text NOT NULL` to `artist_genres`; widen the PK to
  `(artist_id, genre_id, source)`. Values: platform keys plus protected
  `submission` / `manual`.
- `integrate-harvested-genres.mjs` writes the staging row's
  `source_platform` instead of `ON CONFLICT DO NOTHING` on the pair.
- Readers deduplicate on `genre_id` (all reads go through
  [queries.ts](../src/lib/queries.ts), so this is one change site; a view
  is an option if PostgREST embedding gets awkward).
- Purge semantics fall out naturally: purging platform X deletes X's
  claim rows; the genre disappears from the artist only when no claims
  remain. Manual claims always survive.
- Backfill: existing rows get matched against processed
  `artist_harvested_genres` rows (`artist_id` + `genre_id` +
  `source_platform`) where possible; unmatched rows → `unknown`
  (protected).

**Note (per [artists-column-grants](../migrations/supabase_migration_artists_private_columns.sql)
convention):** any table recreation or new column must re-check grants —
new columns are private by default on tables with column-level grants.

### `source_url` audit columns

Keep/extend `source_url` / `source_page_url` columns on derived rows
(images and bios already have them) for audit and one-off repair
scripts — but they are **not** join keys and **not** purge triggers.
Stored URLs get normalized over time (strip-www, share-link
resolution), so equality on them is fragile; the purge trigger is the
URL diff at save time (§4).

---

## 2. The purge routine

One app-level routine, callable from the edit save path and from
scripts:

```
purgePlatformData(artistId, seedPlatforms[], { dryRun })
```

### Phase 1 — resolve the doomed platform set (transitive closure)

Start with the seed platforms. Find this artist's `artist_links` rows
with `source = 'harvest:<doomed platform>'` → their platforms join the
doomed set. Repeat until fixed point, with a visited set so a cycle
(SoundCloud → Linktree → SoundCloud) can't loop. Protected sources
(`submission`, `manual`, `unknown`) are never doomed and never recursed
through.

### Phase 2 — run the per-platform purge over the doomed set

A **registry** — a list of entries, each `(table, verb, scoping)` — is
executed for every doomed platform, then the doomed link rows
themselves are deleted. Three verbs:

- **delete** — remove rows scoped to (artist, platform) — or to a
  service-string namespace, or an edge direction.
- **reset** — null out state columns so an incremental script
  re-processes the artist.
- **null-ref** — clear an FK reference without deleting the row.

The registry doubles as the single documented list of "everything a
platform link feeds," which today is spread across a dozen scripts.
Adding a future platform-derived table = one registry line.

### Registry contents (initial)

**Display/derived tables:**

| Table | Action |
| --- | --- |
| `artist_images` | delete row **and** Storage object (mirrors §7b today, including the log-don't-abort Storage error handling) |
| `biographies` | delete row for the platform; **invalidate the `claude_summary` row** (AI-summary bios are derived from platform bios — delete it so regeneration picks it up) |
| `artist_enrichment` | delete the platform's row |
| `artist_genres` | delete claim rows with `source = <platform>` (genre survives if other claims remain) |

**Staging & caches** (without this, the pipeline re-derives the bad
data):

| Table | Action |
| --- | --- |
| `artist_harvested_links` | delete rows with `source_platform = <doomed>` — rows from surviving sources are kept (see decision 4) |
| `artist_harvested_genres` | delete rows with `source_platform = <doomed>` |
| `artist_harvested_bios` | delete the platform's rows |
| `api_response_cache` | delete entries whose `(namespace, cache_key)` correspond to the artist's doomed URL (per-namespace key derivation lives with the registry entry) |
| `harvest_failures` | delete the platform's service namespaces — image failures as §7b does today, plus the platform's sync/harvest namespaces |

**Downstream computed data.** Organizing principle: **purge = make the
pipeline think it hasn't run yet.** Every downstream table is
maintained by a script with an incremental mode ("which artists lack
X?"), so *delete + reset flag* is the recompute queue — no job system.

| Table | Action |
| --- | --- |
| `sc_follow_edges` (soundcloud doomed) | delete **both directions**: outgoing (followings fetched from the wrong profile) and incoming (other artists' follows resolved to this artist via the wrong URL). Incoming edges stay gone until followers are re-processed — accepted (decision 2). |
| `artist_enrichment.follow_graph_built_at`, `sync_error` | reset to NULL so the graph builder re-processes the artist |
| `mb_tags`, `mb_collaborations` (musicbrainz doomed) | delete the artist's rows (whole table is single-source; no platform column needed); reset any stored MBID/resolution state so re-matching happens |
| `artist_similarity_scores` | delete rows where the artist is the **source**, and delete the **entire score set** of any artist whose top-10 contained the purged artist — an empty set is exactly what queues an artist for the next incremental `compute-scores.mjs` run |

### Reporting

- `dryRun` prints the doomed tree
  (`soundcloud → instagram → …`) and every registry action that would
  run, without writing.
- Real runs from scripts write a datetime-stamped CSV of everything
  deleted (house pattern). The edit-form path runs inline without the
  CSV — its scope is one artist and the server log suffices.

---

## 3. What the purge does *not* need

- **No new recompute scheduling.** See organizing principle above; the
  existing incremental script modes are the queue. Score/graph tables
  also get bulk-rebuilt periodically, so imperfect coverage there costs
  staleness, not permanent corruption.
- **No corroboration check** (decision 4).
- **No provenance ledger / event log.** A per-row source label is
  enough at this scale.

---

## 4. Save-path integration

The edit save path calls `purgePlatformData` with seeds =

1. platforms whose link was **removed**,
2. platforms newly marked **not_found**, and
3. platforms whose **URL changed** — the case that motivated this whole
   design, and a hole today. The save path already loads existing links
   before the delete-all, so the diff is available; compare resolved
   URLs (`urlsMatch`-style, not raw string equality).

Two consequential changes ride along:

- **Provenance must survive the save.** Delete-all-reinsert would stamp
  every link `manual` on any save, silently promoting harvested links
  to protected status. The save must carry the existing `source`
  through for rows whose URL is unchanged and stamp `manual` only on
  rows the human actually added or edited. (Whether that's a diff-based
  upsert or reinsert-with-carried-source is an implementation choice —
  the invariant is what matters.)
- **Drop `trg_artist_links_url_change`** (decision 3). Its job moves
  into the registry's reset entries, on a path that actually fires.
  Note for operators: after this, fixing a link by direct SQL no longer
  queues re-processing — use the purge script instead (OPERATIONS.md
  entry).

§7b's inline image-pruning block is replaced by the routine (its
behavior becomes the `artist_images` + `harvest_failures` registry
entries).

---

## Suggested build order

Ordered so the correctness-critical deletes come before the
self-correcting resets, and so each step is independently shippable:

1. **Schema:** `artist_links.source` + backfill; `artist_genres.source`
   + PK widening + backfill; grants check on both.
2. **Promotion scripts** stop dropping provenance
   (integrate-harvested-links, integrate-harvested-genres). From this
   point, new data is attributed even before the purge exists.
3. **Reader change:** genre dedup in `queries.ts`.
4. **`purgePlatformData`** with registry + dry-run + CSV, covering the
   display/derived tables first (the part where precision matters
   most), then staging/caches, then downstream computed data.
5. **Save path:** URL-diff trigger + source preservation + replace §7b;
   drop the dead trigger.
6. **OPERATIONS.md**: document the script-side purge for direct-SQL
   fixes.

Test-first where the risk concentrates: the phase-1 closure (protected
sources, cycles) and the phase-2 genre-claim semantics.

---

## Alternatives considered

| Option | Why not |
| --- | --- |
| **Synthetic ID per link, FK'd from derived rows** | The original instinct, vindicated only in modified form. `(artist_id, platform)` is already a stable natural key used by every derived table; an ID adds indirection without information. Worse, the save path's delete-all-reinsert regenerates IDs every save — FK cascades would wipe derived data on ordinary edits, or force a rewrite of the save path into careful diffing upserts. The transitive case (links-from-links) needs a source *label*, which `harvest:<platform>` provides. Revisit only if multiple same-platform links ever feed harvesting (see [PROPOSAL-platform-links.md](PROPOSAL-platform-links.md) — its design deliberately keeps the primary uniquely platform-keyed, so nothing here blocks it). |
| **DB triggers / FK cascades for the purge** | The existing trigger is dead on the main path (UPDATE trigger vs. delete-reinsert). Storage-object deletion can't live in SQL. Triggers can't distinguish "human fixed a wrong link" from "script normalized a URL" without convention, and scatter the logic invalidation-by-invalidation instead of one readable registry. |
| **Corroboration check before dooming a harvested link** (keep an Instagram link if another surviving source's staging candidate matches) | Judged too unlikely to build around (decision 4). Surviving-source staging rows are kept regardless, so the next integrate run re-promotes such a link anyway — self-healing without dedicated logic. |
| **`artist_genre_sources` side table** (instead of widening `artist_genres`) | Keeps the main table untouched for readers, but two tables to keep consistent; `select` + dedup through `queries.ts` is one change site. |
| **Provenance ledger / harvest-event log** | Full audit trail of every harvest event. Over-engineered for this scale; per-row source labels answer the only question asked ("what came from platform X?"). |
| **Re-binding incoming follow edges** to a new `sc_followee` node holding the wrong URL (instead of deleting them) | Elegant — the edges are wrong only about which artist the profile maps to — but real complexity for a rare event. Deletion + eventual re-processing accepted instead (decision 2). |

---

## Open questions to evaluate

**1. Backfill coverage.** How many existing `artist_links` rows will
actually match a staging row and get real provenance, vs. landing in
protected `unknown`? If most links end up `unknown`, the transitive
purge does little for existing data (it still fully covers everything
harvested from now on). Worth a quick count query before building —
it changes how much of the value arrives on day one.

**2. Genre PK widening blast radius.** `artist_genres` is embedded in
the shared `ARTIST_SELECT` and joined in several migrations/scripts.
The PK change `(artist_id, genre_id)` → `(artist_id, genre_id, source)`
is mechanical but touches sparse-genre cleanup SQL, the dedup pass in
integrate-harvested-genres, and any `ON CONFLICT` targets. Enumerate
before committing to the widened-PK approach over the side table.

**3. `api_response_cache` key derivation.** Purging cache entries
requires reconstructing each namespace's `cache_key` from the doomed
URL. If some namespaces don't key by URL (or hash it), those entries
can't be targeted — decide per-namespace whether to purge, TTL-expire,
or accept staleness.

**4. How much of phase 2 ships in v1?** The display tables
(images/bios/genres/enrichment) deliver most of the user-visible value
and all of the precision risk. Downstream computed data self-corrects
on rebuild. A v1 that purges display + staging + caches and leaves
scores/edges to the periodic rebuilds is defensible — decide whether
the smaller first ship is worth the temporary inconsistency window.

**5. Does `hoer` count as purgeable?** The HÖR integration wrote links
with knowable provenance. If a HÖR-sourced link turns out wrong, is
per-source purge (`source = 'hoer'`) wanted, or is that cleanup always
manual? Affects only which source values the closure treats as
recursable vs. terminal.
