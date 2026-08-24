# Proposal — organisations (record labels, clubs, events) as real entries

> **Status: phases 1–5 shipped 2026-08-23 and live in production.** Written
> 2026-08-12 from a design discussion; the four shape decisions in
> [Decisions taken](#decisions-taken) are settled.
>
> The migration has been applied, the backfill has been run with `--apply`,
> and the admin panel, public read path and forms are all in `main`. What is
> left is **review work, not build work**: 217 of the 273 organisations are
> still `pending` and need types, links and locations filling in by hand.
>
> **[Phase 6](#8-cleanup)'s code is merged but its SQL has not been run.**
> Nothing reads `artists.labels` any more, so there is no rush and no
> breakage — but the column is still there until
> [`supabase_migration_drop_artists_labels.sql`](../migrations/supabase_migration_drop_artists_labels.sql)
> is pasted into the Supabase SQL editor. `artist_labels` and the artist
> page's dual-read fallback are both deliberately kept.
>
> [Known gaps](#known-gaps) lists what the built system does not handle.
>
> Numbers as at 2026-08-23, after the backfill: **273** organisations (217
> pending, 55 approved, 1 deleted), **491** `artist_organisations` rows,
> **480** `artist_labels` rows still carrying flat text, and **0** remaining
> live `label_etc` artists — pass 2 converted and soft-deleted all 155 of
> them. The 2026-08-12 figures in [Where things stand](#where-things-stand)
> are the original survey and are kept as the before picture.

---

## The problem

An artist's record labels, crews, clubs and events are stored as **flat
strings** in `artist_labels(artist_id, name)`. Nothing can be said about the
thing named: no links, no type, no location, no notes, no way to record who
runs it, and no way to know that "Ostgut Ton" on one artist is the same
organisation as "ostgut ton" on another.

This proposal gives each organisation its own row, with links, a type, a
location, notes, and typed relationships to the artists in the directory.

---

## Where things stand

| Thing | Reality (measured 2026-08-12) |
|---|---|
| `artist_labels` (id, artist_id, **name text**) | 314 rows across 245 artists, **208 distinct names** after normalisation. Top: BPitch Control ×39, DNB Girls ×26, Femme Bass Mafia ×10 |
| `artists.labels` (legacy text column) | 93 rows of comma-separated strings ("UMAY, BPitch Control"). Still listed in `ARTIST_SELECT` but rendered nowhere |
| Display | [`artist/[id]/page.tsx`](../src/app/artist/[id]/page.tsx) — "Associated with: X, Y" as flat text |
| Write paths | Three, all delete-then-reinsert: [`edit/actions.ts`](../src/app/artist/[id]/edit/actions.ts), [`admin/actions.ts`](../src/app/admin/actions.ts), [`api/submit/route.ts`](../src/app/api/submit/route.ts) |
| Input UI | `TextList` free-text rows in the submit / revise / edit forms |
| Related | 12 artists sit at `directory_status = 'label_etc'` (Anjunadeep, ARJUNAMUSIC, Mørk…) — organisations that were submitted as artists |

Data quality is good: only 3 rows contain separators, no URLs, and one junk row
(`she/they`, typed into the wrong field). 208 entities is small enough to
review by hand in one sitting.

---

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Name | **`organisations`**, route `/organisation/[id]` | British spelling, matching the docs' voice. Note existing code identifiers use American spellings (`normalizeSearch`) — this mixes conventions slightly, accepted deliberately |
| Types | **Many-to-many** | Tresor is a club *and* a label; Boiler Room a show *and* a promoter. One extra join table now vs. a data migration plus every read path later |
| Backfill status | **All `pending`**, bulk-approved after review | Nothing goes public until it's been seen — catches the junk row, near-duplicates and artist/org name collisions |
| First pass | **Phases 1–3** (schema, backfill, admin CRUD) | Model and clean the data behind the admin panel; public pages and forms follow |

---

## 1. Schema

Mirrors the patterns already in the database (`genres` / `platforms` lookups,
`artist_links`, `artist_locations`) so existing helpers and conventions carry
over.

```
organisations
  id            uuid pk
  name          text not null
  name_search   text generated  -- same expression as artists.name_search
  status        text  pending | approved | rejected | deleted   (default pending)
  duplicate_of  uuid -> organisations(id)     -- merge pointer, mirrors artists.duplicate_of
  description   text            -- short public blurb (optional)
  run_by_text   text            -- free text for people not in the directory
  notes         text            -- PRIVATE, admin only
  created_at / updated_at

organisation_types              -- lookup table, like platforms
  key text pk, label text, sort_order int
  -- record_label, club, venue, event, festival, party, collective,
  -- radio, promoter, agency, distributor…

organisation_type_links(organisation_id, type_key)      -- many-to-many

organisation_roles              -- lookup, exactly like platforms (see §2)
  key text pk, label text, sort_order int, created_at

organisation_locations(id, organisation_id, city, country)   -- mirrors artist_locations

organisation_links(id, organisation_id, platform -> platforms(key),
                   handle, url, original_url, not_found)
  unique (organisation_id, platform)

artist_organisations
  artist_id        uuid -> artists(id)              on delete cascade
  organisation_id  uuid -> organisations(id)        on delete cascade
  role_key         text -> organisation_roles(key)  on delete restrict
  pk (artist_id, organisation_id, role_key)
```

Three shape decisions worth calling out:

- **"Who runs it" is a role on the join table, not a column.** Organisations
  routinely have several founders, and modelling it as a role means one
  relationship table serves both directions (artist page: "Associated with";
  organisation page: "Run by"). `run_by_text` covers people who aren't and
  won't be in the directory — labels run by men, etc.
- **Many-to-many types**, per the decision above.
- **Type and role lists live in tables, not Postgres enums**, for the same
  reason `platforms` does: you can add "distributor" from the admin panel
  without a code change.

## 2. Roles are editable vocabulary

`role_key` is a foreign key to `organisation_roles`, seeded in the same
migration that creates it (the `genre_tag_rules` precedent — migrate *and*
seed in one go, so an empty table later means rows were deleted, not that
setup is pending):

`associated` · `head` · `curator` · `owner` · `founder` · `co-founder` ·
`resident` · `label manager` · `A&R` · `booker` · `member` · `releases on`

`associated` is the default, the backfill's value for all 314 existing rows,
and the fallback when someone doesn't know the specifics — it is exactly what
today's flat text means.

Because `role_key` is part of the primary key, one artist can hold several
roles at one organisation (owner *and* resident) without duplicate-row hacks.
`on delete restrict` is deliberate: a role in use can't be deleted out from
under existing associations.

Public SELECT on `organisation_roles` is unrestricted, like `platforms` and
`genres` — it's vocabulary, not data.

### Admin UI for roles

A **"Organisation roles"** section on
[`/admin/settings`](../src/app/admin/settings/page.tsx), directly under "Profile
link categories" and built as a copy of it:

- `AddOrganisationRoleForm.tsx` — mirrors
  [`AddPlatformForm.tsx`](../src/app/admin/AddPlatformForm.tsx): one text input,
  one Add button, inline error/success, form reset on success.
- `addOrganisationRole()` in [`admin/actions.ts`](../src/app/admin/actions.ts) —
  mirrors `addPlatform()`: `requireAdmin()`, reuse the existing `slugify()`
  helper for the key, reject duplicates by key, assign
  `sort_order = max + 10`, `revalidatePath()` the affected routes.
- Existing roles render as chips below the form, same as the platform chips.

Two things `addPlatform` doesn't do that this should, since role vocabulary
needs correcting more often than platform vocabulary does:

- **Rename** — edit the `label` in place, leaving `key` untouched so existing
  rows follow along.
- **Delete, guarded** — refuse when the role is in use (the `restrict` FK
  enforces it at the database level anyway) and report how many associations
  block it, rather than surfacing a raw Postgres error.

Shipping add-only first, at parity with the platforms panel, is acceptable —
the FK guard still prevents damage — but the rename is cheap and will be
wanted the first time "A&R" gets typed as "AR".

## 3. Security (same migration, not a follow-up)

The July 2026 audit found `artists.notes` readable through the publishable
key. Don't repeat it:

- Revoke table-level SELECT on `organisations` from anon/authenticated,
  re-grant per column, **excluding `notes`** — copy
  [`supabase_migration_artists_private_columns.sql`](../migrations/supabase_migration_artists_private_columns.sql).
- RLS: public SELECT only where `status = 'approved'`; join tables visible
  only when both sides are approved (`artist_organisations` needs the
  two-sided check that `artist_labels` does one-sided today).
- No anon INSERT — mirror
  [`supabase_migration_artists_revoke_anon_insert.sql`](../migrations/supabase_migration_artists_revoke_anon_insert.sql).
  Public submissions create organisations server-side with the service key,
  as `pending`.
- Column-grant caveat: new columns are private by default and must be
  re-granted after any drop/recreate.

## 4. Backfill — `scripts/migrate-labels-to-organisations.mjs`

Follows the HÖR-binding convention: `--dry-run` by default, `--apply` to
write, timestamped CSV report. Non-destructive — `artist_labels` stays
untouched until phase 7.

1. Read the 314 `artist_labels` rows and comma-split the 93 legacy
   `artists.labels` strings.
2. Group by `normalizeSearch()` (reuse the existing helper so it matches the
   Postgres expression), pick the most common surface form as the canonical
   name.
3. Create ~208 `organisations` (all `pending`) plus `artist_organisations`
   rows with `role_key = 'associated'`.
4. Write an ambiguity CSV for hand review: near-duplicate normalisations, the
   3 separator rows, the `she/they` junk row, and any organisation name that
   collides with an existing artist name (Discwoman, UMAY — real cases where
   the person and the organisation share a name).
5. Second pass for the 12 `label_etc` artists: name-match them to
   organisations, port their `artist_links` into `organisation_links`, mark
   the artist rows deleted, log every action to CSV.

Nothing gets a type, location or link automatically — those are filled in the
admin UI afterwards. That's the real work, and 208 entries is a bounded
manual job.

## 5. Read path

- [`types.ts`](../src/lib/types.ts): `Organisation`, `OrganisationType`,
  `OrganisationRole`, `OrganisationLink`, `ArtistOrganisation`.
- [`queries.ts`](../src/lib/queries.ts): swap `label_list:artist_labels(*)` in
  `ARTIST_SELECT` for the nested organisation select; drop the dead `labels`
  column from the select. `CARD_SELECT` is unchanged — the grid doesn't
  render this.
- Artist page: associations grouped by role, ordered by `sort_order`, one
  line per role; `associated` renders as today's "Associated with". Names
  become links. **Dual-read during transition** — render organisations when
  present, fall back to `label_list` otherwise, so the page is never blank
  mid-migration. A `pending` organisation counts as absent for this purpose,
  or artists whose only organisation is unapproved would lose the line
  entirely.
- New public route `/organisation/[id]`: name, types, location, links
  (reusing `platformLabel`), the role-inverted people list ("Head: …",
  "Curator: …", "Residents: …"), and the associated directory artists.
  `notes` is never rendered.

## 6. Admin UI for organisations

`/admin/organisations` — list + search, create/edit form (name, types,
locations, links via the existing
[`ProfileLinksFieldset`](../src/components/form/ProfileLinksFieldset.tsx) and
[`LocationList`](../src/components/form/LocationList.tsx), per-artist role
picker, notes), a moderation queue for `pending` organisations mirroring
[`GenreModerationPanel`](../src/app/admin/GenreModerationPanel.tsx), and a
**merge** action that repoints `artist_organisations` and sets
`duplicate_of`.

Merge is the one that matters long-term: free-text entry will keep producing
"Ostgut Ton" / "ostgut-ton" pairs.

## 7. Forms (submit / revise / edit)

The "Labels / crews" `TextList` is replaced by an **Organisations** field using `OrganisationList`: a native
`<input list>` + `<datalist>` over the approved organisations. Type-ahead
over real entries, still accepts a name that isn't one, and no custom
dropdown state to get wrong. Matching is on the normalised name key, so
"ostgut ton" resolves to the existing "Ostgut Ton" rather than proposing a
near-duplicate.

**Typing a new name does NOT create an organisation.** This reverses what §3
of this document originally assumed, and the migration header has been
corrected to match. The decision (2026-08-23):

> A submitter may ATTACH an artist to an organisation that already exists
> and is approved. A name they type stays flat text in `artist_labels` and
> becomes an organisation when an **admin approves the artist**.

Why, in short — `organisations` is a shared, cross-artist namespace with its
own public page, and `/api/submit` writes the artist as `unverified` when the
email is unconfirmed:

- Creating rows there lets anyone past Turnstile write to that namespace,
  where **whoever types a name first owns its canonical spelling**.
- `name_search` is indexed but **not unique** — the only duplicate guard is
  `findByNormalisedName` in the admin action, so an unguarded submit path
  would manufacture exactly the pairs the merge tool exists to clean up.
- 9 of 549 submissions to date were rejected; each would have left
  organisation rows behind with nothing linking them back.
- And it buys nothing: the picker only offers *approved* organisations, so a
  pending row is invisible to the next submitter and to every page until an
  admin approves it — which is precisely when the approval path creates it.

Ids posted by the browser are **re-checked server-side** before being
trusted: an organisation can be rejected, merged or deleted between the page
rendering and the form being posted, and a stale id degrades to a typed name
rather than dropping the row.

Promoted organisations are created **pending**, not approved. Approving an
artist says "this person belongs in the directory", not "this label is
correctly named, typed and located" — that judgement happens on
`/admin/organisations`. The dual-read keeps showing the flat text meanwhile,
so nothing is lost by waiting.

**Roles are admin-only, and the split is enforced on the server.**

- The **public** submit and revise forms show no role picker and post no
  role. `resolveOrganisationInputs` is called without `allowRoles` there, so
  a hand-edited request claiming `role_key: 'head'` still lands as
  `associated`. A stranger must not be able to assert that somebody runs a
  label, and `associated` is exactly what the old flat text meant anyway.
  Those paths scope their deletes to `associated`, so roles an admin set
  survive a public revision untouched.
- The **admin** edit form shows every organisation the artist is attached
  to, with a per-row role picker, and owns the complete set — so its delete
  is unscoped, because removing a row there must actually remove it.

This corrected a defect (2026-08-23). The admin form originally reused the
public seeding, which filters to `associated` — so an artist who was `head`
of an organisation saw an **empty box**, while their public page rendered
"Head: …". Ten associations were invisible that way, including Gabrielle
Rites, who holds two roles at one organisation. `initialOrganisationRows`
(public, associated-only) and `initialOrganisationRowsWithRoles` (admin, all
roles) are now separate functions so the two can't be confused again.

A newly typed name still promotes as `associated` regardless of the picker:
its organisation doesn't exist yet, and the row is created by the promotion
step. The form says so rather than silently dropping the choice.

`RevisionData` accepts **both** shapes: `organisations` from the current
form, and `labels: string[]` from any revision written before this shipped.
A revision already in the queue was written by the old form and nobody is
going to rewrite it.

All of it lives in [`organisation-writes.ts`](../src/lib/organisation-writes.ts)
— `resolveOrganisationInputs`, `attachOrganisations`,
`promoteArtistLabelsToOrganisations` — shared by `/api/submit`,
`approveRevision`, `quickApprove`/`quickApproveArtist` and the admin edit
form, so the rule is stated once.

## 8. Cleanup

Originally "drop `artist_labels`, drop `artists.labels`, remove the fallback
branch". Two of those three no longer apply, so what is left is smaller than
it looks.

### What phase 6 actually is: dropping `artists.labels`

The legacy comma-separated column, already out of `ARTIST_SELECT` since
phase 4 and rendered nowhere. A short tail comes with it:

| Also needs changing | Why |
|---|---|
| The `"labels"` entry in [`supabase_migration_artists_private_columns.sql`](../migrations/supabase_migration_artists_private_columns.sql) | That file is re-runnable and lists granted columns explicitly. Leaving a dropped column in it makes the whole migration fail — exactly what the file already documents happening with `linktree_url` |
| `Artist.labels` in [`types.ts`](../src/lib/types.ts) | Already optional and marked deprecated |
| [`migrate-labels-to-organisations.mjs`](../scripts/migrate-labels-to-organisations.mjs) | Still selects `labels` and comma-splits it (`splitLegacyLabels`). It would break on its next run, and it is idempotent precisely so it *can* be re-run |

**Nothing is copied out of the column first**, and that is a reversal worth
recording. An earlier draft of the migration rescued the names living only
there into `artist_labels`, so the drop would be provably lossless. Measured
against production it turned out to be unnecessary and actively harmful:

- 93 artists carry a non-empty legacy column, and **7 names live only
  there**. **Five** are already attached to that same artist as an
  organisation — the relationship is modelled, the text is redundant.
- The other two are both "Exhale", whose organisation an admin has since set
  to `status = 'deleted'`. Copying the name back would undo that decision on
  the next approval, because promotion reuses an existing row whatever its
  status.
- **Three of the seven are not organisations at all** — `she/they` and
  `she/her` (pronouns typed into the wrong field) and
  `Blind Harmonies (label owner)`. Both pronoun rows belong to **approved**
  artists, and `artist_labels` is exactly what the artist page falls back to
  — so the rescue would have printed a stranger's pronouns as an affiliation
  on two live public pages that currently show nothing there.

So the column is dropped as-is: what it holds is either already modelled
properly or already been decided against.

### What is NOT phase 6 any more

**`artist_labels` stays.** That assumption did not survive phase 5. With
submitters barred from creating organisations, the table stopped being
"legacy flat text" and became **the staging area for names not yet resolved
to an organisation** — it is where a typed name lives between submission and
admin approval. Dropping it needs a replacement holder, which is a design
question, not a `DROP`.

**The artist page's fallback branch stays too**, and should be re-read rather
than removed. It is no longer migration scaffolding waiting to be deleted; it
is the permanent answer to "this artist has a label that is not yet an
approved organisation", which is a state new submissions keep producing. Only
its comment needs updating, to stop describing itself as temporary.

---

## Known gaps

Phases 1–5 are shipped and working. These are the things that are *not*
handled, recorded 2026-08-23 so they are known rather than discovered.

### 1. A newly promoted organisation is indistinguishable from a backfilled one

The one most likely to bite. [`/admin/organisations`](../src/app/admin/organisations/page.tsx)
selects `id, name, status, duplicate_of` and orders by **name** —
`created_at` is not even fetched. So an organisation promoted from a
submission this morning lands alphabetically among the 217 pending backfilled
rows with nothing to mark it out. `/admin` carries only a nav link, with no
pending count and no mention in the submissions queue, so nothing signals
that one arrived. Finding it means already knowing its name.

Cheap to fix: fetch `created_at`, add a newest-first sort, put a pending
count on `/admin`. Worth doing before the backfill queue is worked through,
because until then new arrivals are hidden in a crowd of 217.

### 2. Uniqueness is enforced only in application code

`organisations.name_search` is indexed but **not unique**. The entire
duplicate guarantee is `findOrganisationByName` at promotion time and
`findByNormalisedName` in the admin create/rename actions. Two promotions
racing on the same new name would both insert, and the database would not
stop them.

All 273 organisations currently have distinct `name_search` (checked
2026-08-23), so a unique index would apply cleanly today. It needs one
decision first: a merged loser keeps its name, so the index has to allow for
that — most likely `WHERE duplicate_of IS NULL AND status <> 'deleted'`.

### 3. Near-duplicates are never caught automatically

Matching is exact-normalised only. "Ostgut Ton" and "Ostgut Ton Berlin" are
two rows and always will be. `scripts/lib/organisation-backfill.mjs` has
trigram near-duplicate detection (`findNearDuplicates`), but that is a
one-off script — nothing in the running app does it, and the merge tool is
manual and needs somebody to spot the pair first. Lifting that function into
a "possible duplicates" panel on `/admin/organisations` is the obvious fix,
and the biggest piece of work of the three.

---

## Sequencing

| Phase | Ships independently? | Notes |
|---|---|---|
| 1 Schema + roles + grants | **built** | nothing reads it yet |
| 2 Backfill | **built** | dry-run → review CSV → apply |
| 3 Admin CRUD + merge + roles panel | **built** | types/links/locations get filled in by hand here |
| 4 Read path + organisation pages | **built** | dual-read means no coupling to phase 2 finishing |
| 5 Forms | **built** | needs approved organisations to exist |
| 6 Cleanup | **built** | only `artists.labels`, dropped as-is — see [Cleanup](#8-cleanup) |

Phases 1–3 were the agreed first pass; 4, 5 and 6 followed the same day.

---

## How to run it

### 1. Apply the schema

Paste [`supabase_migration_organisations.sql`](../migrations/supabase_migration_organisations.sql)
into the Supabase SQL editor. It is one transaction and safe to re-run.

It creates all seven tables, seeds both vocabularies, and sets up RLS,
column grants and the write revokes in the same file — §3's "same
migration, not a follow-up". Verified against a local PostgreSQL 17.6
(matching production): `notes` and `select *` are denied to `anon`,
`name_search` stays filterable, pending organisations are invisible, the
`artist_organisations` policy hides a row unless *both* sides are approved,
and a role in use cannot be deleted.

### 2. Backfill

```
npm run migrate-labels-to-organisations             # dry run
npm run migrate-labels-to-organisations -- --apply
```

The dry run works before the migration has been applied — it reports the
missing table and carries on against an empty target, which is how you find
out how many organisations you are about to create. `--apply` refuses in
that state.

Three CSVs land in the output folder either way:

| File | What it is |
|---|---|
| `organisations-plan-<stamp>.csv` | one row per organisation: the canonical name, every surface form that collapsed into it, and the artists attached |
| `organisations-ambiguity-<stamp>.csv` | everything a human has to decide, highest-signal reasons first |
| `organisations-label-etc-<stamp>.csv` | pass 2's actions on the `label_etc` artists |

The ambiguity reasons, in the order they are reported:

- `pronouns_in_label` — every word is a pronoun; somebody typed the wrong
  field. The `she/they` row the proposal predicted, plus a `she/her`.
- `matches_pronoun_row` — matches a row in the `pronouns` table but doesn't
  read as pronouns. This points the *other* way: production has a pronouns
  row reading `BØX collectif`, which is an organisation name typed into the
  pronouns field.
- `separator_in_name` — a slash or spaced `&`/`+`/`x` that might be two
  organisations in one field. Not split automatically; `R&S Records` is one
  name and guessing is worse than asking.
- `name_collides_with_artist` — an **approved** artist has the same
  normalised name. Both rows are usually correct (the person and the thing
  they run) and the reviewer needs to see them side by side.
- `near_duplicate` — trigram-similar keys that didn't collapse, e.g.
  `BØX Collectif` / `BØX Collective`.
- `multiple_surface_forms` — the canonical pick discarded a spelling
  somebody typed; shows what was dropped.
- `name_matches_unreviewed_artist` — matches an `sc_followee` / `obscure` /
  `not_eligible` import rather than a listed artist. Usually the
  organisation is already in `artists` under the wrong kind of row, and the
  fix is to set that artist to `label_etc`, which hands it to pass 2.

**Nothing in this report is acted on automatically.** Every group becomes a
pending organisation regardless; the CSV is a worklist, not an input.

An artist already at `directory_status = 'label_etc'` is deliberately
**excluded** from the collision check, because pass 2 owns it and it has its
own CSV. The count is printed instead, so the exclusion is visible rather
than silent. This matters more than it sounds: setting `label_etc` *is* the
resolution of a `name_matches_unreviewed_artist` row, so counting those rows
as collisions meant a reviewer working through the report got their own
resolved rows handed straight back on the next run — 123 of them, on the run
that caught this. The report only converges because they are excluded.

`--skip-label-etc` runs pass 1 alone. Pass 2 soft-deletes the artist rows
it migrates (`deleted = true`), which is reversible; `artist_labels` and
`artists.labels` are never touched.

### 3. Review in the admin panel

`/admin/organisations` — status tabs, name search, per-row approve /
reject / delete, and a **bulk approve** scoped to whatever the filter is
currently showing, so ~238 pending rows get reviewed in batches instead of
one click at a time.

`/admin/organisations/<id>` — name, status, types, locations, links
(reusing `ProfileLinksFieldset` and `LocationList` unchanged), run-by text,
description, private notes; the per-role artist list; and the merge action.

`/admin/settings` gains **Organisation roles** and **Organisation types**
panels: add, rename in place (the key stays, so existing rows follow), and
delete guarded by a live usage count.

### 4. What the public site does now

**Artist page** — `Associated with:` becomes one line per role, ordered by
the role vocabulary's `sort_order`, with organisation names linking to
`/organisation/<id>`. It **dual-reads**: an artist with no approved
organisation falls back to the old flat `artist_labels` text, so the line
never disappears mid-migration. `normalizeArtist()` filters on
`status = 'approved'`, which is what makes a pending organisation count as
absent for admins too, not just for anonymous visitors.

**`/organisation/[id]`** — name, types, location, links, run-by text and the
role-inverted artist list. Noindexed. Renders nothing for a section it has
no data for, so a bare organisation is just a name rather than a page of
empty headings.

Two things worth knowing about the read path:

- The nested `organisations(...)` select **must name its columns**. `notes`
  has no grant for the public roles, so `select=*` on that table is rejected
  with a 42501 — through an embed as much as directly. Verified against
  production with the publishable key.
- `roleHeading()` takes a direction. `associated` reads "Associated with" on
  an artist page and "Associated" on an organisation page; the same string
  in both places reads backwards in one of them.

---

## Worth knowing

- **Free upside later:** a shared organisation is a strong similarity signal
  for the recommendation engine — a sixth signal alongside
  genre / MB-tag / follow-graph, and cheap to compute once this exists. Out of
  scope, but the schema doesn't preclude it. See
  [`SCORING.md`](SCORING.md).
- **Out of scope, flagged now:** whether organisations appear in homepage
  search, whether they get their own directory listing and filter, and
  organisation images. All additive later.
- **HÖR** (`hoer_terms`, `hoer_sets`) is itself an event/radio show that could
  become an organisation row — deliberately not touched here.

---

## Open questions

Answered when phase 4 was built (2026-08-23):

- ~~Should `/organisation/[id]` pages be indexed?~~ **Noindexed** via
  `robots: { index: false, follow: false }` in the route's metadata. Most of
  the ~240 backfilled organisations carry a name and nothing else, and
  indexing a few hundred near-empty pages is quick to do and slow to undo.
  Simpler than the question assumed: this app has no sitemap at all, so the
  metadata block is the whole of it. Lift it once the entries are filled in.
- ~~All associated artists, or only approved ones?~~ **Only approved**, and
  by construction rather than by a filter: `getOrganisationById` goes
  through the public client, so the two-sided RLS policy on
  `artist_organisations` does it. The consequence is real and accepted — 8
  of the first 55 approved organisations currently show no artists at all,
  because theirs are still in review.
- Is `description` worth having at all in the first pass, given `notes`
  already covers the admin-facing need and nobody has asked for public
  organisation blurbs? **Built as specified** — the column exists, is
  publicly granted, and has a field on the admin form. Nothing renders it
  yet, so dropping it in phase 4 is still cheap if it stays empty.

Two more that phases 1–3 answered by building:

- **Do organisation types need an admin panel?** Yes — §1 justifies the
  lookup table by "you can add *distributor* from the admin panel without a
  code change", which only holds if the panel exists. Roles and types share
  one component and one set of actions.
- **What does merge do with the loser's types, locations and links?**
  Nothing. Only the artist associations move; the winner has its own
  curated set and silently mixing two link lists produces a row nobody
  chose. The loser stays readable at its admin URL so anything worth
  keeping can be copied across first.
