# Proposal — paste-to-detect platform links

> **Status: proposal, not accepted.** Written 2026-07-16 from a design
> discussion. Nothing here is built, and the decision to build it has **not**
> been made. See [Open questions to evaluate](#open-questions-to-evaluate) at
> the end — that section is the point of this document. If you're returning to
> this cold, read the open questions first, then decide whether the plan below
> is worth doing at all.

---

## The problem

The submit, revise, and edit forms render **one link field per platform**
([`ProfileLinksFieldset.tsx`](src/components/form/ProfileLinksFieldset.tsx)
maps over every row in the `platforms` table). That's manageable at today's
platform count and unusable at ~100 platforms.

## The proposed shape

One list of "paste a URL" rows. The platform is **auto-detected from the URL**
and displayed next to the field as **read-only text** (not an editable
dropdown). Unrecognized URLs are filed as `other`.

Each known platform holds **one primary link**. A second link for an
already-filled platform is filed as `other` (unlimited) rather than discarded,
which is what harvesting does today.

`not_found` is retained, but moves out of the URL rows into its own control.

---

## 1. The core rule

Platform assignment is a **pure derivation over an ordered list**, never stored
independently per row:

> Walk links in order. Detect each URL's host-platform. The **first** link on a
> given known host takes that platform; every later link on the same host — and
> anything on an unrecognized host — becomes `other`.

Implement once as `assignPlatforms(rows) => rows-with-platform`, called from
both the client form (on every change) and the server ingestion path. Two
properties fall out for free:

- Deleting a primary **auto-promotes** the next same-host link to primary — the
  derivation just re-runs. No special promotion code.
- The invariant "≤1 primary per known platform, unlimited `other`" holds by
  construction.

Detection itself is a host lookup against a data-driven domain map (§2),
reusing the existing subdomain-safe `hostMatchesDomain` and the existing
pre-steps in [`src/lib/profile-links.ts`](src/lib/profile-links.ts):
`unwrapRedirectUrl` (Instagram/Facebook shims) and, server-side,
`resolveShareUrl` (`on.soundcloud.com`).

### Why this shape wins

Because the primary is still uniquely `platform=<known>`, **every read-side
consumer keeps working untouched**. That is the main argument for this design
over "allow multiple links per platform" — see
[Alternatives considered](#alternatives-considered).

---

## 2. Data model changes

**`platforms` table** — make detection data-driven, so an admin can add a
platform without a deploy (same reasoning as the existing
`search_url_template` column, see
[`supabase_migration_platform_search_templates.sql`](supabase_migration_platform_search_templates.sql)):

- Add `domains text[]` — e.g. `youtube → {youtube.com, youtu.be}`,
  `bandcamp → {bandcamp.com}`.
- Backfill from the existing `domainHints` in `profile-links.ts`'s `CONFIG`
  (soundcloud, instagram, bandcamp, resident_advisor) plus every other platform.
- Add the matching field to the `Platform` type in
  [`src/lib/types.ts`](src/lib/types.ts).

**`artist_links` table** — enforce the invariant in the DB:

- **Partial unique index:** unique on `(artist_id, platform)`
  **where `platform <> 'other'`**. At most one of each known platform;
  unlimited `other`.
- Optional `position int` to persist overflow order. Insertion-id order is
  fine for v1.
- **No new columns needed** for the future labels/crews idea — an `other`
  link's host is recoverable from its URL.

---

## 3. Form state & UI

Replace the platform-keyed maps in all three forms
([`SubmissionForm.tsx`](src/components/SubmissionForm.tsx),
[`RevisionForm.tsx`](src/components/RevisionForm.tsx),
[`EditForm.tsx`](src/app/artist/[id]/edit/EditForm.tsx) — currently
`Record<platform, string>`, plus `Record<platform, boolean>` for not-found in
the edit form) with an **ordered list**:

```
LinkRow = {
  id: string;         // client-generated, stable React key
  text: string;       // the ONLY authoritative field (what's in the input)
  platform: string;   // DERIVED via assignPlatforms — not stored
  note: Note | null;  // DERIVED (warning / "filed as Other" explanation)
}

links: LinkRow[]      // order = priority
notFound: string[]    // platform keys — edit form only (unchanged)
```

Behavior:

- **Row identity** is a client-generated id (counter / `randomUUID`) — never
  the platform (duplicates are now possible) and never the array index
  (deleting a row would make the inputs below it inherit stale state).
- **Detection** runs on paste + on blur, so the label appears immediately for
  the common paste case. **Normalization** (rewriting the text to canonical
  form) stays on blur so it doesn't fight the cursor — same as
  [`ProfileLinkField.tsx`](src/components/ProfileLinkField.tsx) does today via
  `normalizeProfileLink`.
- **Read-only platform label** beside each row, projected from
  `assignPlatforms`.
- **When a row is downgraded to `other`** because the slot is taken, the note
  must say *why* — e.g. "Other — this artist already has a primary SoundCloud
  link." Without this, pasting a soundcloud.com URL and seeing "Other" reads as
  a bug. See the open questions.
- **Adding rows:** either a spreadsheet-style trailing blank row (auto-append
  when the last gains content) or an explicit "+ Add link". Blank rows are
  dropped on serialize, not validated as errors.
- **Prefill (edit/revise):** map `artist.links` 1:1 into rows. Trust the
  **stored** platform rather than re-detecting — the DB value may reflect a
  server-only resolution the client detector can't reproduce (an expanded
  `on.soundcloud.com` share link). Re-derive only once the row's text is edited.

### `not_found`

Stays a **separate affordance** (edit form only, as today): a "mark a platform
as not found" dropdown → chips (`SoundCloud — not found ✕`). It stays separate
because it's a **platform-first** statement with no URL to derive from, whereas
the paste rows are **URL-first**. Forcing it through the URL input is what
produced the awkward magic-string idea (see Alternatives).

This does *not* reintroduce the ~100-fields problem: the negative path is rare,
admin-only, and was already a checkbox per rendered field. One occasional
dropdown is strictly less UI than 100 checkboxes.

One refinement: the guard becomes "can't mark SoundCloud not-found if a
**primary** SoundCloud link exists." An `other` link that happens to be on
soundcloud.com doesn't block it — the artist isn't on SoundCloud themselves but
appears on a label's page, which is coherent.

---

## 4. Wire format

All three forms converge on **one array**, replacing the
`Partial<Record<platform, url>>` payload that submit/revise send today (edit
already sends an array):

```
links: Array<{ platform: string; url: string; not_found: boolean; position: number }>
```

Serialize = drop blank rows → map each `LinkRow` to
`{platform, url, not_found: false, position}` → concat
`notFound.map(p => ({platform: p, url: '', not_found: true}))`.

---

## 5. Save path

Whole-set replace — the partial unique index prevents conflicts, and delete-all
first avoids ordering problems:

1. Delete all `artist_links` for the artist.
2. Insert the submitted set in order, each through `resolveProfileLinkUrlAsync`
   + `deriveHandle` (unchanged from
   [`src/app/artist/[id]/edit/actions.ts`](src/app/artist/[id]/edit/actions.ts)).

The image-pruning block in the same file still works — a platform survives if
any surviving link has it — but **reword its comment**: the premise "the form
submits an entry for every platform" is no longer true. It becomes "a platform
absent from the submitted set has no links."

---

## 6. Ingestion / harvesting

Where harvesting currently **discards** a second same-platform link, apply the
same rule instead: run `assignPlatforms` against the artist's existing stored
links plus the new one; a taken slot → insert as `other`. Check-first is
clearer than catching a unique violation and downgrading. The partial unique
index is the backstop.

---

## 7. Read side — explicitly unchanged

Nothing here needs to change, because the primary is still uniquely
`platform=<known>` and the overflow hides under `other`:

- SoundCloud widget selection —
  [`src/app/artist/[id]/page.tsx`](src/app/artist/[id]/page.tsx) (`find(l => l.platform === "soundcloud")`)
- Image enrichment / `PLATFORM_PRIORITY`
- SoundCloud/Bandcamp sync scripts
- `getArtistsMissingLink` anti-join —
  [`src/lib/queries.ts`](src/lib/queries.ts) (missing = zero rows; unchanged)
- Profile-link display (`page.tsx`) — already maps all non-not_found links;
  overflow simply renders as "Other". Improving that label (append the handle
  or domain) is optional and not required.

---

## Suggested build order

1. **Schema:** `platforms.domains` + backfill; partial unique index on
   `artist_links`.
2. **Detection + `assignPlatforms`** in `lib/profile-links.ts` — build
   **test-first**; there's already
   [`profile-links.test.ts`](src/lib/profile-links.test.ts).
3. **Shared list UI component**, replacing `ProfileLinksFieldset` /
   `ProfileLinkField`.
4. **Wire the three forms** to the list + unified array payload; update the
   submit/revise/edit actions to the one shape and the whole-set save.
5. **Ingestion:** swap discard-second for assign-to-`other`.
6. **`not_found`** dropdown + primary-only exclusion guard.

---

## Alternatives considered

| Option | Why not |
| --- | --- |
| **Keep one field per platform** | The problem being solved — unusable at ~100 platforms. |
| **Strict one-per-platform, discard extras** | Current harvesting behavior. Throws away real data (label/podcast links) that's wanted later for labels/crews. |
| **Allow multiple links per platform** | Uniform and simpler on the write side (no contextual assignment, no partial index), but relocates the cost to the **read side**: every consumer that does `find(l => l.platform === X)` — the SoundCloud widget, image enrichment, sync scripts — needs a "which one is primary?" rule, plus a `position` column and an artist-page grouping decision (two identical "SoundCloud" labels side by side). Rejected: multiple links per artist are uncommon, and when they occur it's usually an **alias** (better modelled as its own artist entry) or a **label/crew** (better modelled as its own entity later). |
| **Magic string for not-found** (typing `soundcloud not found` into the URL field) | Cumbersome, and worse: requires knowing the platform *key* spelling, pollutes a URL field with non-URLs, and is ambiguous with a genuinely broken URL. A dropdown shows friendly labels and can't be mistyped. |
| **Editable platform dropdown per row** | Defeats the purpose — the read-only label is the requirement. An override could be added later (see open questions). |

---

## Open questions to evaluate

**The big one: is this worth doing at all?** The ~100-platform scenario driving
it is hypothetical today. The plan touches all three forms, the wire format,
the save path, ingestion, and the schema. Weigh that against how close the
platform count actually is to being a problem.

**1. The "why does this say Other" surface.** This is the only genuinely new UX
oddity in the whole design. Pasting an obviously-SoundCloud URL and seeing
"Other" needs an inline explanation or it reads as broken. Cheap to build,
but decide whether the explanation actually lands for someone unfamiliar with
the primary/overflow concept.

**2. `assignPlatforms` is where the risk concentrates.** Everything else is
mechanical. The derivation is the piece that's contextual (a row's platform
depends on the *other* rows), and the piece both the form and ingestion depend
on. Build it test-first. If this function is wrong, links get silently
misfiled.

**3. "First-in-order wins" is usually right, occasionally wrong.** If the
label's SoundCloud is pasted or harvested *before* the artist's own, the wrong
one becomes primary. Almost always fine in practice (the main profile comes
first), but there's no correction path in v1 short of removing and re-adding in
order. Decide whether that's acceptable to ship, or whether a **manual "make
this the primary" control** (pin a row, exclude it from the first-wins pass) is
needed on day one. Deliberately deferred here.

**4. Auto-promotion may feel magical.** Delete the primary SoundCloud row and
the overflow row's label silently flips from "Other" to "SoundCloud". It's
*correct*, but it's the derivation acting at a distance. Worth watching in
practice.

**5. Read-only with no escape hatch.** If detection misfires (custom domain,
something that should be recognized but falls to `other`), there's no way to
correct it. An optional "not right? change" revealing a dropdown would need a
`pinned` flag so the manual pick survives re-detection — which complicates the
pure derivation. Deferred; confirm that's tolerable.

**6. Deferred by design, confirm you're happy with that:**
   - Manual primary override (see #3, #5).
   - Labels/crews as first-class entities. The `other` overflow links are the
     raw material. When that lands, either re-parse hosts from the stored URLs
     or add a `detected_platform` column at that point. Nothing in this plan
     blocks it.
   - Improving the "Other" display label on the artist page.
