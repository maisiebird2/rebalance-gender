# Proposal — organisations (record labels, clubs, events) as real entries

> **Status: plan, not yet built.** Written 2026-08-12 from a design
> discussion. The four shape decisions in [Decisions taken](#decisions-taken)
> are settled; nothing below has been implemented. Read
> [Where things stand](#where-things-stand) first — the existing data is small
> and clean, which is what makes this worth doing now rather than later.

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
| Display | [`artist/[id]/page.tsx`](src/app/artist/[id]/page.tsx) — "Associated with: X, Y" as flat text |
| Write paths | Three, all delete-then-reinsert: [`edit/actions.ts`](src/app/artist/[id]/edit/actions.ts), [`admin/actions.ts`](src/app/admin/actions.ts), [`api/submit/route.ts`](src/app/api/submit/route.ts) |
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
[`/admin/settings`](src/app/admin/settings/page.tsx), directly under "Profile
link categories" and built as a copy of it:

- `AddOrganisationRoleForm.tsx` — mirrors
  [`AddPlatformForm.tsx`](src/app/admin/AddPlatformForm.tsx): one text input,
  one Add button, inline error/success, form reset on success.
- `addOrganisationRole()` in [`admin/actions.ts`](src/app/admin/actions.ts) —
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
  [`supabase_migration_artists_private_columns.sql`](supabase_migration_artists_private_columns.sql).
- RLS: public SELECT only where `status = 'approved'`; join tables visible
  only when both sides are approved (`artist_organisations` needs the
  two-sided check that `artist_labels` does one-sided today).
- No anon INSERT — mirror
  [`supabase_migration_artists_revoke_anon_insert.sql`](supabase_migration_artists_revoke_anon_insert.sql).
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

- [`types.ts`](src/lib/types.ts): `Organisation`, `OrganisationType`,
  `OrganisationRole`, `OrganisationLink`, `ArtistOrganisation`.
- [`queries.ts`](src/lib/queries.ts): swap `label_list:artist_labels(*)` in
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
[`ProfileLinksFieldset`](src/components/form/ProfileLinksFieldset.tsx) and
[`LocationList`](src/components/form/LocationList.tsx), per-artist role
picker, notes), a moderation queue for `pending` organisations mirroring
[`GenreModerationPanel`](src/app/admin/GenreModerationPanel.tsx), and a
**merge** action that repoints `artist_organisations` and sets
`duplicate_of`.

Merge is the one that matters long-term: free-text entry will keep producing
"Ostgut Ton" / "ostgut-ton" pairs.

## 7. Forms (submit / revise / edit)

Replace `TextList` with an autocomplete against approved organisations: pick
an existing one, or type a new name that creates a `pending` organisation for
moderation, with an optional role alongside it.

`RevisionData.labels` needs a back-compat read — existing pending revisions in
`artist_revisions` still carry `labels: string[]`, so the revision-apply path
in [`admin/actions.ts`](src/app/admin/actions.ts) must accept both shapes for
one release.

## 8. Cleanup

Once phases 5–7 have shipped and the dual-read has been live for a release:
drop `artist_labels`, drop `artists.labels`, remove the fallback branch.

---

## Sequencing

| Phase | Ships independently? | Notes |
|---|---|---|
| 1 Schema + roles + grants | yes | nothing reads it yet |
| 2 Backfill | yes | dry-run → review CSV → apply |
| 3 Admin CRUD + merge + roles panel | yes | types/links/locations get filled in by hand here |
| 4 Read path + organisation pages | yes | dual-read means no coupling to phase 2 finishing |
| 5 Forms | yes | needs approved organisations to exist |
| 6 Cleanup | after a release of soak | |

Phases 1–3 are the agreed first pass.

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

- Should `/organisation/[id]` pages be indexed (sitemap, OG images) from day
  one, or noindexed until types and links are filled in? Thin pages at launch
  argue for the latter.
- Does the public organisation page list *all* associated artists, or only
  approved ones? Only approved is the safe default, but it will make some
  organisations look emptier than they are.
- Is `description` worth having at all in the first pass, given `notes`
  already covers the admin-facing need and nobody has asked for public
  organisation blurbs?
