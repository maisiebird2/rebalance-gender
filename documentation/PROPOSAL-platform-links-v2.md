# Proposal — paste-to-detect platform links (v2)

> **Status: BUILT, 2026-08-29** (branch `platform-links-paste-detect`),
> superseding [PROPOSAL-platform-links.md](PROPOSAL-platform-links.md) (v1,
> 2026-07-16). The design below is what shipped; the notes under each open
> question record how it was decided. The migration
> `supabase_migration_artist_links_overflow.sql` must be applied by hand in the
> Supabase SQL editor **before** the code is deployed — the revision-apply
> merge stops working the moment the old upsert meets the new index.
>
> Two rules the plan left implicit turned out to be needed, and are worth
> knowing about because neither is obvious from the sections below:
>
> - **A repeated link is not a second link.** Without an identity check,
>   pasting the same URL twice produced a primary and an `other` duplicate of
>   it, and the revision merge created a fresh one on every approval.
>   `assignPlatforms` reports a `duplicate` and keeps the link once.
> - **A URL is canonicalised by what it IS, not by the slot it lands in.** An
>   overflow SoundCloud link is stored under `other` but still cleaned as a
>   SoundCloud URL; `cleanGenericUrl("other", …)` would have left the tracking
>   query on it. The stored `handle` stays keyed to the STORED platform, so a
>   row's handle and platform never disagree.
>
> **Corrected 2026-08-30:** the `djanes` domain added with this work was
> wrong. DJanes lives at `djanes.world-clubs.com`, a subdomain of a general
> clubs directory — not at `djanes.net`, which was a guess. The pattern is
> anchored to that subdomain so it cannot claim `world-clubs.com` at large.
>
> > One thing §2 gets wrong about the schema: `artist_links` carried **two**
> unique constraints, not one. `artist_links_artist_platform_unique` was
> replaced as planned; `artist_links_artist_id_platform_url_key`
> (`artist_id, platform, url`) was deliberately kept — it is what stops the
> overflow bucket filling with byte-identical copies.

---

## What changed since v1

Every difference between this document and v1 traces back to one of these.

1. **Platform detection now exists, centralised.**
   [`src/lib/classify-platform-url.ts`](../src/lib/classify-platform-url.ts)
   (2026-07-21, extended 2026-08-16) is the single source of truth for
   URL → platform-key: a ~25-domain `DOMAIN_PLATFORM_MAP`, a policy skip list
   (twitter/x/t.co are refused outright), per-harvester configs, and
   `reclassifyResolvedUrl` for links whose real destination only becomes known
   after resolution. v1 planned to *invent* detection by backfilling a DB
   column from the four `domainHints` in `profile-links.ts`; the shared
   classifier is already broader than that plan.

2. **URL resolution moved off the save path.** The edit save no longer awaits
   `resolveProfileLinkUrlAsync`; saves canonicalise synchronously and hand off
   to [`scheduleLinkResolution`](../src/lib/schedule-link-resolution.ts),
   which runs [`resolve-artist-links.ts`](../src/lib/resolve-artist-links.ts)
   after the response. Crucially, that pass can **rewrite a row's platform**
   (a shortener saved as `other` resolves to soundcloud.com), and it already
   carries a *taken-slots* guard so a reclassification onto an occupied
   `(artist_id, platform)` pair is caught before the write. In other words: a
   third of this proposal's core rule is already implemented, in a different
   file, under a different name.

3. **`artist_links` already has a full unique constraint on
   `(artist_id, platform)`.** The revision-apply upsert
   ([`admin/actions.ts`](../src/app/admin/actions.ts), `onConflict:
   "artist_id,platform"`) depends on it, and
   [`supabase_migration_organisations.sql`](../migrations/supabase_migration_organisations.sql)
   created the explicit twin for `organisation_links`. v1 framed the partial
   unique index as *adding* enforcement of a new invariant. In reality the
   existing constraint **forbids the design's central feature** — a second
   `other` row — so the schema change is a replacement, and the writers that
   lean on the full constraint have to change with it (§2, §5).

4. **There is a fourth form.**
   [`OrganisationEditForm.tsx`](../src/app/admin/organisations/OrganisationEditForm.tsx)
   renders the same `ProfileLinksFieldset` (with `not_found`) over the
   separate `organisation_links` table. v1's "all three forms" is now four
   forms across two link tables (§3, open question 8).

5. **The read side moved.** The artist page now renders links through
   `visiblePublicLinks` in [`src/lib/platforms.ts`](../src/lib/platforms.ts)
   — a curated `PLATFORM_DISPLAY_ORDER` that is both ordering and, on public
   pages, an allowlist — shared with the organisation page. `other` is in the
   allowlist. Rows also gained an `original_url` column (the URL as typed,
   kept when resolution rewrites `url`).

6. **The writer inventory is larger than "the forms plus harvesting".** §5
   and §6 now enumerate it; v1 reasoned about three forms and one ingestion
   script, which undercounts by half.

---

## The problem (unchanged)

The submit, revise, edit and organisation forms render **one link field per
platform**
([`ProfileLinksFieldset.tsx`](../src/components/form/ProfileLinksFieldset.tsx)
maps over every row in the `platforms` table). Manageable at today's ~20
platforms, unusable at ~100.

## The proposed shape (unchanged)

One list of "paste a URL" rows. The platform is **auto-detected from the URL**
and shown as **read-only text**. Unrecognised URLs are filed as `other`. Each
known platform holds **one primary link**; a second link on an already-filled
host is filed as `other` (unlimited) instead of being discarded. `not_found`
moves out of the URL rows into its own control.

---

## 1. The core rule

Unchanged in substance:

> Walk links in order. Detect each URL's host-platform. The **first** link on
> a given known host takes that platform; every later link on the same host —
> and anything on an unrecognised host — becomes `other`.

Implement once as `assignPlatforms(rows) => rows-with-platform`. Deleting a
primary still auto-promotes the next same-host link, and the invariant
"≤1 primary per known platform, unlimited `other`" holds by construction.

What v2 changes is **what it is built from and where it runs**:

- **Detection is `classifyPlatformUrl`**, not a new domain map. v1's plan to
  derive detection from `profile-links.ts`'s `domainHints` (now five
  platforms, still only the templated ones) would have re-created a second,
  narrower copy of exactly the table whose per-script copies
  `classify-platform-url.ts` was written to kill. `assignPlatforms` is a thin
  ordered-fold over the existing classifier. The pre-steps stand:
  `unwrapRedirectUrl` client-side, resolution server-side (now asynchronous —
  see §5).
- **`null` is not `other`.** `classifyPlatformUrl` returns `null` for
  policy-skipped hosts (twitter/x/t.co), non-http schemes and unparseable
  input. The form must surface those as an inline "this link can't be
  accepted" state, not silently file them as `other` — filing a policy-refused
  host under `other` would smuggle excluded links into the database through
  the front door.
- **Three call sites, not two.** The client form and server ingestion, as in
  v1, *plus the post-save resolution pass*. `resolve-artist-links.ts` already
  answers "the resolved destination's slot is taken" — today by skipping the
  reclassification. Under this design the answer becomes "keep it as `other`
  (and still rewrite the URL)", which is the same rule `assignPlatforms`
  applies everywhere else. One rule, three doors.

The read-side argument also stands: the primary is still uniquely
`platform=<known>`, so every consumer keeps working untouched.

---

## 2. Data model changes

**Dropped from v1: the `platforms.domains text[]` column.** v1 wanted
detection data-driven so an admin could add a platform without a deploy. Since
then the detection table became shared code with shape a `text[]` can't
express — regex matches, a policy skip list, per-caller skips/overrides/
fallbacks (`CLASSIFY_CONFIGS`), and a deliberate mixcloud → `other` mapping.
Moving it to the DB now means either losing that expressiveness or building a
rules engine. And the no-deploy benefit was always thinner than it looked:
adding a platform *usefully* also means canonicalisation rules in
`profile-links.ts`'s `CONFIG`, which is a deploy anyway, and the client form
needs the map in its bundle to detect on paste. Keep the map in code; if
no-deploy platform addition ever becomes a real need, data-driving the domain
table is a separable refactor.

**`artist_links` — replace, don't add:**

- Drop the existing `UNIQUE (artist_id, platform)` constraint; create the
  partial unique index on `(artist_id, platform)` **where
  `platform <> 'other'`**.
- This breaks the revision-apply upsert: PostgREST/supabase-js `onConflict`
  cannot target a partial index, and `other` rows have no conflict target at
  all. The merge in `admin/actions.ts` must become read-modify-write through
  `assignPlatforms` (§5) — which its merge semantics need under this design
  anyway.
- The `platform → platforms.key` FK stays. It is also why sync-linktree's
  bare-domain staging keys can never leak into `artist_links` (relevant to
  open question 7).
- Optional `position int` to persist overflow order; insertion order is fine
  for v1 of the build.
- `original_url` and `not_found` (url `NULL`) rows work unchanged.

**`organisation_links`** — decide explicitly (open question 8): either the
same constraint change and save-path treatment, or the organisation form is
scoped out and keeps a strict one-per-platform list UI. Do **not** leave it
implicit; the form component is shared today.

---

## 3. Form state & UI

As v1, with the ordered `LinkRow[]` replacing the platform-keyed
`Record<string, string>` maps (all four forms build one:
[`SubmissionForm.tsx`](../src/components/SubmissionForm.tsx),
[`RevisionForm.tsx`](../src/components/RevisionForm.tsx),
[`EditForm.tsx`](../src/app/artist/%5Bid%5D/edit/EditForm.tsx),
[`OrganisationEditForm.tsx`](../src/app/admin/organisations/OrganisationEditForm.tsx)):

```
LinkRow = {
  id: string;         // client-generated, stable React key
  text: string;       // the ONLY authoritative field
  platform: string;   // DERIVED via assignPlatforms — not stored
  note: Note | null;  // DERIVED (warning / "filed as Other" / "not accepted")
}
```

The v1 behaviours stand: row identity by client id, detect on paste + blur,
normalise on blur only (as
[`ProfileLinkField.tsx`](../src/components/ProfileLinkField.tsx) does via
`normalizeProfileLink`), read-only label, explanatory note when a row is
downgraded to `other`, trailing blank row or "+ Add link", blank rows dropped
on serialise.

New or sharpened in v2:

- **Prefill must trust the stored platform — now non-negotiable.** v1 argued
  this from one case (an expanded `on.soundcloud.com` link). Post-save
  resolution generalises it: the server rewrites URLs *and platforms* a beat
  after every save, so a freshly loaded edit form routinely holds rows the
  client detector cannot reproduce. Re-derive a row only once its text is
  edited.
- **Refused hosts get an inline error, not `other`** (§1). The note should
  say why: "Twitter/X links aren't accepted."
- **Undetectable platforms are a real hole** — see open question 9. `homepage`
  heads `PLATFORM_DISPLAY_ORDER` yet can never be host-detected; `hoer`,
  `djanes` and `1001tracklists` are live platform keys with no entry in
  `DOMAIN_PLATFORM_MAP`, so their URLs would file as `other`. The
  mappable ones need map entries as part of this work; `homepage` needs its
  own affordance (recommended: keep a dedicated homepage field beside the
  paste list — like `not_found`, it is a platform-first statement, not a
  URL-first one).

### `not_found`

Unchanged from v1: a separate "mark a platform as not found" dropdown → chips,
edit form only (and the organisation form, if in scope). The guard becomes
"can't mark a platform not-found if a **primary** link for it exists"; an
`other` row on the same host doesn't block it. Note the markers are real
`artist_links` rows (`url NULL, not_found true`) that
[`integrate-harvested-links.mjs`](../scripts/integrate-harvested-links.mjs)
treats as human decisions (collisions go to a CSV, never overwritten) — the
serialised form must keep emitting them, and the partial index still permits
exactly one per known platform, which is the desired shape.

---

## 4. Wire format

As v1 — the forms converge on one array, replacing the
`Partial<Record<platform, url>>` that submit/revise send today (edit already
sends an array):

```
links: Array<{ platform: string; url: string; not_found: boolean; position: number }>
```

One addition: **pending revisions are stored payloads.**
`api/revise` writes `revision_data` and the links only become rows when an
admin approves, possibly days later. At deploy time the queue will hold
old-shape payloads, so the apply path in `admin/actions.ts` must read both
shapes until the queue drains (or the stored payloads are migrated once).

---

## 5. Save paths

v1 described one save path; there are five writers on the app side. Per-path
treatment:

- **Edit** ([`actions.ts`](../src/app/artist/%5Bid%5D/edit/actions.ts)) —
  already the whole-set replace v1 §5 asked for (delete-all, insert, sync
  canonicalisation via `resolveProfileLinkUrl`, then
  `scheduleLinkResolution`). Changes needed: accept the array in link-list
  order, run `assignPlatforms` server-side before insert, and reword the
  §7b image-pruning comment whose premise ("the form submits an entry for
  every platform", actions.ts:443) stops being true. The pruning logic itself
  survives: a platform is kept if any surviving link has it.
- **Submit** ([`api/submit/route.ts`](../src/app/api/submit/route.ts)) —
  switch payload shape, run `assignPlatforms`, insert in order.
- **Revision apply** ([`admin/actions.ts`](../src/app/admin/actions.ts)) —
  the deliberate merge ("don't delete links not mentioned") stays, but the
  mechanism changes from upsert-on-constraint to read-modify-write: load the
  artist's current links, append the revision's, run `assignPlatforms` over
  the combined ordered set, write the result. Required regardless of intent,
  because the partial index can't back the upsert (§2).
- **Missing-links admin actions**
  ([`missing-links/actions.ts`](../src/app/admin/missing-links/actions.ts)) —
  single-row add and not-found marker. The add's delete-then-insert stays
  idempotent; it just needs the slot check (a taken slot files the new link as
  `other`, or simply keeps its current replace semantics — decide when
  building).
- **Post-save resolution** ([`resolve-artist-links.ts`](../src/lib/resolve-artist-links.ts))
  — change the taken-slot outcome from "skip the reclassification" to "keep
  `platform='other'`, still rewrite the URL", aligning it with the shared
  rule (§1).

---

## 6. Ingestion / harvesting

[`integrate-harvested-links.mjs`](../scripts/integrate-harvested-links.mjs)
today treats an existing `(artist, platform)` row's URL as canonical and
inserts nothing for that pair (mismatches go to a review CSV). Under this
design a genuinely *different* URL on a taken slot inserts as `other` instead
of being dropped. Keep the existing behaviours that are orthogonal: not-found
collision CSVs, the platforms-table key check, and URL-identity dedupe (a
harvested link equal to the stored canonical one still inserts nothing —
overflow is for *different* links, not copies). Check-first remains clearer
than catching the unique violation; the partial index is the backstop.

---

## 7. Read side — still explicitly unchanged

The v1 argument holds, with updated references:

- SoundCloud widget — [`page.tsx`](../src/app/artist/%5Bid%5D/page.tsx)
  (`find(l => l.platform === "soundcloud" && !l.not_found)`).
- Image enrichment — `PLATFORM_PRIORITY` now lives in
  [`src/lib/scrape-images.ts`](../src/lib/scrape-images.ts).
- `getArtistsMissingLink` — [`queries.ts`](../src/lib/queries.ts) anti-join,
  unchanged. Note the semantics are *right*, not merely preserved: an artist
  whose only soundcloud.com link is a label page filed as `other` genuinely
  is missing their own SoundCloud.
- Public link display — `visiblePublicLinks` allowlists and orders; `other`
  is in `PLATFORM_DISPLAY_ORDER`, so overflow renders. Several `other` rows
  will show as repeated "Other" chips side by side, which makes the optional
  label improvement (append the domain or handle) more attractive than it was
  in v1 — but it stays optional.

---

## Suggested build order

1. **Schema:** drop the full unique constraint, add the partial index
   (+ `organisation_links` if in scope). Nothing user-visible changes yet —
   all writers currently maintain one-per-platform on their own.
2. **`assignPlatforms`** on top of `classifyPlatformUrl`, test-first
   ([`classify-platform-url.test.ts`](../src/lib/classify-platform-url.test.ts)
   and [`profile-links.test.ts`](../src/lib/profile-links.test.ts) show the
   house style). Add the missing `DOMAIN_PLATFORM_MAP` entries (`hoer`,
   `djanes`, `1001tracklists`).
3. **Rework the revision-apply merge** to read-modify-write (it breaks the
   moment step 1 lands in prod if left as an upsert — so in practice steps
   1–3 ship together).
4. **Shared list UI component** replacing `ProfileLinksFieldset` /
   `ProfileLinkField`, including the homepage affordance and refused-host
   errors.
5. **Wire the forms** (three artist forms + the organisation decision) to the
   list and the unified payload; update submit/edit actions.
6. **Ingestion & resolution:** integrate-harvested-links overflow-to-`other`;
   resolve-artist-links taken-slot behaviour.
7. **`not_found`** dropdown + primary-only guard.

---

## Alternatives considered

Carried over from v1 unchanged — one field per platform (the problem),
strict-discard (loses data), multiple links per platform (moves the cost to
every read-side consumer), magic not-found strings, editable platform
dropdowns. See [PROPOSAL-platform-links.md](PROPOSAL-platform-links.md) for
the full table.

Two rows need updating:

- **Data-driven `platforms.domains`** moves from "the plan" to "rejected for
  now" — reasons in §2.
- **Merging `artist_harvested_links` into `artist_links`** — the v1 analysis
  (2026-08-13) stands, and the merge has since got *harder*: staging now
  legitimately holds platform keys that can never enter `artist_links`
  (sync-linktree's bare-domain keys, `mixcloud`), because the live table's FK
  on `platforms.key` — a safety property this proposal relies on — rejects
  them. A merge would need to relax that FK or migrate those keys. The cheap
  provenance path remains
  [PROPOSAL-provenance-purge.md](PROPOSAL-provenance-purge.md)'s `source`
  column (that proposal is still unbuilt as of 2026-08-29).

---

## Open questions to evaluate

> **Decided: yes, build it.**

**The big one, still: is this worth doing at all?** The forcing scenario
(~100 platforms) remains hypothetical; the visible platform list is ~20 keys.
Since v1 the plan's blast radius grew (four forms, five writers, a constraint
replacement, the revision-queue compat window) — but so did the payoff
surface: the fieldset now burdens the organisation form too, and every new
platform key makes all four forms longer. Weigh both sides with current
numbers, not v1's.

1. *(Built.)* Every outcome that isn't "this is your SoundCloud link" carries
   an inline reason: overflow, unrecognised host, repeated link, and the two
   that can't be stored. The last kind blocks the save rather than being
   dropped — a link that silently vanishes is worse than one that refuses to.
   A bare handle became a **fourth** case the plan didn't anticipate: the old
   per-platform fields could build a URL from `techno_blondy` because they knew
   the platform up front, and a paste list cannot.

   **The "why does this say Other" surface.** Unchanged from v1, plus the new
   sibling state "not accepted" for refused hosts (§1). Both need inline
   explanations or they read as bugs.

2. **`assignPlatforms` is where the risk concentrates.** Unchanged — except
   the risk is now *lower* on detection itself (the classifier exists, is
   tested, and is battle-tested by six harvesters) and *higher* on
   integration: three call sites (§1) that must agree, one of which
   (resolution) runs detached after the response.

3. **First-in-order wins is occasionally wrong.** Unchanged: no correction
   path in v1 of the build short of remove-and-re-add. Decide whether a
   "make primary" pin is needed on day one. Still deferred here.

4. **Auto-promotion may feel magical.** Unchanged — and post-save resolution
   adds a second action-at-a-distance: a row can change platform between the
   save and the next page load (`schedule-link-resolution.ts` deliberately
   doesn't revalidate). Same answer as v1: watch it in practice.

5. **Read-only with no escape hatch.** Unchanged; a `pinned` override
   complicates the pure derivation and stays deferred.

6. **Deferred by design, confirm you're happy:** manual primary override;
   labels/crews as entities (the `other` rows remain the raw material —
   re-parse hosts from stored URLs when that lands); richer "Other" display
   labels.

7. *(Decided: NO, as recommended.)* `artist_harvested_links` stays separate.

   **Merge the staging table while you're here?** The v1 recommendation
   stands — decide it *with* the go/no-go, not after — but the FK/bare-key
   wrinkle above tilts it further toward "no, use the `source` column".

8. *(Decided: OUT, as recommended.)* `organisation_links` keeps its full
   unique constraint, and the admin organisation form keeps the old
   `ProfileLinksFieldset`, which now exists solely for it. No strict mode was
   needed on the new list.

   **Organisations: in or out?** *(new)* The shared fieldset means the
   organisation form changes UI either way. In: `organisation_links` gets the
   same constraint replacement and save-path work (its save is already
   whole-set replace). Out: the list component needs a strict
   one-per-platform mode, or the old fieldset survives for one admin form.
   Recommendation: **out for the first release** — organisations rarely need
   overflow links and the admin audience tolerates a second-pass migration —
   but make it an explicit decision.

9. *(Decided: dedicated field, as recommended.)* A homepage input sits beside
   the paste list and serialises first. The server honours a client's platform
   claim only where detection has no answer of its own — the same policy
   `reclassifyResolvedUrl` applies — which is what lets `homepage` survive a
   round trip without letting a client relabel an obvious SoundCloud URL.

   **What happens to `homepage`?** *(new)* A first-class, first-displayed
   platform that host-detection can never assign. Recommended: a dedicated
   homepage input beside the paste list (platform-first, like `not_found`).
   Alternatives: an editable-platform exception for unrecognised URLs only,
   or accepting that homepages file as `other`. This needs an answer before
   the UI is designed, not after.

10. *(Built: read both, indefinitely.)* `parseLinkPayload` reads either shape,
    so no migration of stored payloads and no window to close. The admin
    revision preview reads through it too, so a queued revision of either
    vintage renders the same way.

    **The revision-queue compatibility window.** *(new)* How long must the
    apply path read old-shape `revision_data` — until the queue drains, or is
    a one-off migration of stored payloads cleaner? Small either way; decide
    so it doesn't linger forever.
