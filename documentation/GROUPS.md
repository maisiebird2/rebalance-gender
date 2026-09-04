# Groups — duos, bands and collectives as directory entries

> **Status: plan, not built.** Written 2026-09-02 from a design discussion.
> Nothing in here exists yet: there is no migration applied, no
> `artist_group_members` table, and no `group` row in `artist_types`. The
> numbered sections describe what to build and why; [Decisions
> taken](#decisions-taken) records the choices that were settled up front and
> the readings they ruled out.

---

## The problem this solves

The directory models one kind of thing: an individual artist. A duo, a band
or a collective can only be entered as an artist row like any other, which
means:

- Nothing records that it *is* a group, so nothing can display or filter on
  the distinction.
- The people in it cannot be named, and where a member has their own entry
  there is no way to connect the two.
- It gets a **Pronouns** field, which is meaningless for a group and invites
  a wrong answer.

After this work, `group` is a checkbox on the same **Types** control that
already carries producer / DJ / vocalist; ticking it reveals a **Members**
list and hides **Pronouns**.

---

## Decisions taken

Four choices were settled before planning, because each changes the shape of
the work.

**1. The group keeps its own single name.** `artists.name` stays exactly as
it is — one name per row, "Nitzer Ebb". The members are a *separate*
repeating list beneath it, not a multi-valued replacement for the name field.

The rejected reading was to make `name` itself one-to-many, so that a duo
billed only as "A & B" would be named by its list. That would reach into
directory search, `name_search`, the normalised name key, dedupe, artist
cards and every read of `artists.name` — a much larger change for a case
that an ordinary group name plus a members list already covers.

**2. `group` is a row in `artist_types`, not a boolean on `artists`.** It
sits in the closed vocabulary alongside `producer` / `dj` / `vocalist` and is
ticked on the same control. Two consequences follow, both wanted:

- The types are a *set*, so a group can also be a producer. Right for a live
  act that also releases records.
- `group` renders as a pill on artist cards and artist pages with no display
  work at all, because both already map over `artist.types`.

The cost is that the slug `"group"` becomes load-bearing in the UI: it is
what decides whether **Members** appears and **Pronouns** hides. That is a
behaviour no other type has, so it gets one exported constant —
`GROUP_TYPE_SLUG` — rather than a string literal repeated across three
forms.

**3. All three forms get the Types checkboxes.** They exist today only on the
admin edit form. Submit and revise get them too, so a member of the public
can say "this is a group" at the point they know it, rather than an admin
having to infer it during review. Without this the group fields would never
appear on a public form at all.

**4. A member URL resolves to a real foreign key.** Pasting an artist's
All Frequencies URL stores that artist's id, so the group page renders a
live link and the reverse "member of" view becomes possible later. A row with
no URL — or one that resolves to nothing — is kept as a plain text name. The
rejected alternative, storing the URL as typed, is smaller but leaves broken
links undetectable and forecloses the reverse view.

---

## 1. Migration — `supabase_migration_artist_groups.sql`

One file, two parts.

### 1a. Seed the vocabulary row

```sql
INSERT INTO "public"."artist_types" ("name", "label", "sort_order") VALUES
    ('group', 'group', 4)
ON CONFLICT ("name") DO NOTHING;
```

Same idempotent shape as the original seed in
`supabase_migration_artist_types.sql`, so a re-run is safe and any later
hand-edit to the label or ordering survives.

### 1b. `artist_group_members`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity, PK | A surrogate key. Unlinked members carry `member_artist_id IS NULL`, and two nulls cannot form a key, so `(group_artist_id, member_artist_id)` will not serve. |
| `group_artist_id` | uuid NOT NULL | FK → `artists(id)` ON DELETE CASCADE. |
| `member_artist_id` | uuid **NULL** | FK → `artists(id)` ON DELETE **SET NULL** — deleting a member's own entry must not silently drop them out of the group's line-up; the name stays, the link goes. |
| `name` | text NOT NULL | As typed. This is the display text whether or not the row resolved, so the list reads correctly even when nothing is linked. |
| `sort_order` | integer NOT NULL | The list is ordered and the form's order is the author's intent. |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes and constraints:

- Partial unique index on `(group_artist_id, member_artist_id) WHERE
  member_artist_id IS NOT NULL` — the same artist cannot be listed twice in
  one group, while any number of unlinked names may coexist.
- Index on `member_artist_id`, for the reverse "member of" lookup. Cheap now,
  and it is what makes [that follow-up](#deliberately-out-of-scope) a display
  change rather than a migration.
- RLS mirroring `artist_type_assignments`: public `SELECT` only where the
  **group** artist is `approved`.
- `GRANT SELECT` to `anon` and `authenticated`; `GRANT ALL` to
  `service_role`. Writes stay with the service role, as everywhere else.

### Why not reuse `collaborations`

`collaborations` holds one **undirected** edge per artist pair, with
`source_platform` and `collab_count`, and it feeds the recommendation scorer
(`compute-scores.mjs`, `scripts/lib/scoring.py`). Membership is different in
all three respects: it is **directed** (group → member), it is
**hand-entered** rather than harvested, and it must hold names that match no
artist row at all. Writing membership into that table would put manual rows
into a harvested signal and inflate the collaboration score.

Deriving collaboration edges *from* membership — everyone in a group has
plainly worked with everyone else in it — is a clean follow-up with its own
`source_platform`, and is not part of this work.

---

## 2. Shared library — `src/lib/group-members.ts`

Three write paths apply identical rules, which is exactly the situation
`src/lib/organisation-writes.ts` already answers for organisations. Model
this on it.

```ts
export const GROUP_TYPE_SLUG = "group";
export function isGroup(types: string[]): boolean;

export async function resolveMemberInputs(
  admin: SupabaseClient,
  rows: GroupMemberFormRow[],
): Promise<ResolvedMember[]>;

export async function replaceGroupMembers(
  admin: SupabaseClient,
  groupArtistId: string,
  rows: GroupMemberFormRow[],
): Promise<void>;
```

`resolveMemberInputs` parses each URL with the existing, already-tested
`parseArtistIdInput()` from `src/lib/duplicate-of.ts` — it accepts a bare
UUID or any URL containing one, which covers every real shape of a copied
address bar. It then checks the id names a real, non-deleted artist, drops
blank rows, dedupes on the resolved id, and preserves order.

**A URL that resolves to nothing degrades to a plain text name rather than
failing the save.** A stale or mistyped link should not cost a submitter
every other field they filled in.

`replaceGroupMembers` is delete-then-insert, the idiom the edit form already
uses for genres, aliases and links.

Unit tested as `src/lib/group-members.test.ts`, beside
`organisation-writes.test.ts`.

---

## 3. Form components

### `src/components/form/TypeCheckboxes.tsx` (new)

The checkbox block lives inline in `EditForm.tsx` today. Extracting it is
what makes "all three forms" cheap, and it is the stated reason the other
form parts are shared — see the comment at the top of `TextList.tsx`: a field
should look and behave identically whether you are submitting, revising or
editing.

### `src/components/form/MemberList.tsx` (new)

A repeating list of rows, each *name* + *All Frequencies URL*. Build it like
`LocationList`, which is already a two-field repeating row with add/remove.
The URL field's placeholder should make it plainly optional:
`https://…/artist/… (optional)`.

---

## 4. The three forms

Field order becomes:

**Types → Name → Members (when `group`) → Aliases → Pronouns (unless
`group`) → …**

Types moves to the top because it now governs the fields below it. On the
admin edit form, **Status** stays above everything — it is the review
control, not a content field — with Types directly beneath it and above
Basic info.

| | `SubmissionForm` | `RevisionForm` | `EditForm` |
|---|---|---|---|
| Types checkboxes | **new** | **new**, prefilled from `artist.types` | moved to the top |
| Members list | **new**, shown when `group` | **new**, prefilled | **new**, prefilled |
| Pronouns | hidden when `group` | hidden when `group` | hidden when `group` |

`src/app/submit/page.tsx` and `src/app/artist/[id]/revise/page.tsx` need to
load and pass `typeOptions`, the way `src/app/artist/[id]/edit/page.tsx`
already does.

### URL checking differs by surface, deliberately

The **admin** form gets an on-blur resolve showing `✓ links to <Name>`,
reusing the `checkDuplicateTarget` pattern via a new `checkArtistReference`
server action.

The **public** forms do not. An endpoint that confirms whether an arbitrary
artist id exists is an enumeration surface, and it does not belong on an
anonymous form. The server resolves on save either way, so nothing is lost
but the immediate feedback.

---

## 5. Write paths

All three go through `group-members.ts`, which is the point of having it.

**`src/app/api/submit/route.ts`** — accept `types?: string[]` and
`members?: { name: string; url?: string }[]`. Write
`artist_type_assignments` rows with `source: 'manual'`, validated against the
closed vocabulary; an unknown slug is **dropped**, not a 500, because this is
a public endpoint and a bad client should not be able to fail a submission
loudly. (The admin path keeps its existing loud rejection: there, an unknown
slug is a bug in the form.)

**`saveArtist`** (`src/app/artist/[id]/edit/actions.ts`) — members alongside
the existing "Replace MANUAL type assignments" block.

**`approveRevision`** (`src/app/admin/actions.ts`) — extend `RevisionData`
with `types` and `members`, and apply both.

### Pronouns, on all three paths

When `group` is among the types, force `pronoun_id = null` and ignore any
posted `pronouns` value.

This matters most on the edit path. An existing artist re-marked as a group
would otherwise keep the pronoun that the now-hidden field no longer shows —
stored, invisible, and still rendering on the public page.

### Un-checking `group`

Delete that artist's member rows. Otherwise unchecking leaves orphaned
members behind a field that is no longer displayed, which will resurface
confusingly if the box is ever ticked again.

---

## 6. Read and display

- `ArtistGroupMember` interface in `src/lib/types.ts`; `members:
  ArtistGroupMember[]` on `ArtistWithRelations`.
- Add `members:artist_group_members(...)` — with a nested `artists(id, name)`
  join — to `ARTIST_SELECT` in `src/lib/queries.ts`. **Not** to
  `CARD_SELECT`: the grid does not render members, and that select was
  deliberately slimmed to stop shipping unused relations for 24 tiles a page.
- **Artist page** (`src/app/artist/[id]/page.tsx`): a Members block under the
  header. Each member is a link to `/artist/<id>` where the join returned a
  row, and plain text otherwise — the same dual-read fallback the
  organisations line already uses. A member whose own entry is still pending
  therefore reads as text rather than a dead link.
- **Pronouns need no display change.** `[artist.pronoun?.value,
  locationText].filter(Boolean)` already drops a null cleanly, on both the
  artist page and the card.
- **`ArtistCard` needs no change either** — the `group` pill arrives through
  the existing types pills.
- **`SubmissionsPanel`**: show `rd.types` and `rd.members` in the revision
  diff, and members on the pending-artist card. Without this a reviewer
  approves changes they cannot see.

---

## 7. Tests and docs

- `src/lib/group-members.test.ts` — URL parsing, an unresolvable URL
  degrading to text, dedupe, ordering, blank rows.
- Extend `src/app/admin/actions.test.ts` — approving a revision applies
  members and types, and nulls the pronoun for a group.
- Add `artist_group_members` to the "Key database tables" table in
  [CONTEXT.md](CONTEXT.md).
- Add this doc to the index in [README.md](README.md).

---

## Deliberately out of scope

None of these block the work above; each is a clean follow-up.

- **"Member of" on the individual's page** — the reverse view. The index is
  in the migration, so it is a display change when wanted.
- **Member names in directory search** — a `name_search` column on
  `artist_group_members`, mirroring `artists` and `artist_aliases`, so
  searching an *unlinked* member's name finds their group. Linked members are
  already findable through their own entry.
- **Group vs individual as a directory filter.**
- **Backfilling** existing duos and collectives already in the directory as
  untagged artists.
- **Collaboration edges derived from membership** — see [why not reuse
  `collaborations`](#why-not-reuse-collaborations).

---

## Suggested execution order

Roughly four commits:

1. **Schema and library** — migration, `group-members.ts`, its tests.
2. **Components and forms** — `TypeCheckboxes`, `MemberList`, the three
   forms, the two pages that must pass `typeOptions`.
3. **Write paths** — submit route, `saveArtist`, `approveRevision`, including
   the pronoun-clearing and un-check rules.
4. **Display and docs** — `ARTIST_SELECT`, artist page, `SubmissionsPanel`,
   CONTEXT.md, README.md.

The migration is applied by hand in the Supabase SQL editor before step 3 is
useful, as with every other migration here.
