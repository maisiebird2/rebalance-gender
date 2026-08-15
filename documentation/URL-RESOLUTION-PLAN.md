# URL redirect resolution — implementation plan

One shared library for "this URL's true target is only knowable over the
network", called from three places: the form save paths, the harvested-link
promoter (2d), and a new backfill over `artist_links`.

Status: **plan only — nothing implemented.** Branch `resolve-url-redirects`,
cut from `origin/main` at `44400f0`.

Scope note: this is about **resolution** (a network round-trip that answers
"where does this actually point?"), not **canonicalization** (the string
tidying that `classify-platform-url.ts` and `profile-links.ts` already own).
The library returns a final URL and nothing more; existing normalizers run
afterwards, unchanged. `resolve-residentadvisor-urls.mjs` looks adjacent but
is a pure host swap with zero `fetch` calls — out of scope.

---

## Why

Two independent redirect-followers already exist, and they disagree on nearly
every detail:

| | `resolveShareUrl`<br>`src/lib/profile-links.ts:739` | `resolveShortLink`<br>`scripts/integrate-harvested-links.mjs:442` |
|---|---|---|
| Hosts | `on.soundcloud.com` | `bit.ly` |
| Method | HEAD `redirect:"follow"`, GET fallback, reads `res.url` | HEAD `redirect:"manual"`, reads `Location`, ≤5 hops |
| Timeout | 5 s | 8 s |
| Query string | stripped | kept |
| Destination validated | yes — must land on `soundcloud.com` | **no** |
| On failure | returns original | returns `null` |
| Reclassifies platform | no | yes |
| User-Agent | default | `RebalanceGenderBot/1.0` |

Two hosts covered between them. The census below found **fourteen** distinct
redirect-style hosts in the data, most of them handled by neither.

### Census — 2026-08-08

Scanned all 200,127 live `artist_links` and 195,689 staged
`artist_harvested_links` rows.

| Host | Live | Staged | Currently stored as |
|---|---:|---:|---|
| `youtu.be` | 166 | 976 | `youtube` |
| `on.soundcloud.com` | 10 | 523 | `soundcloud` |
| `bit.ly` | 0 | 306 | `other` |
| `smarturl.it` | 17 | 268 | `other` / `smarturl.it` |
| `tinyurl.com` | 10 | 157 | `other` |
| `goo.gl` | 10 | 127 | `other` |
| `ffm.to` | 13 | 160 | `other` / `ffm.to` |
| `lnk.to` | 13 | 97 | `other` / `lnk.to` |
| `soundcloud.app.goo.gl` | 6 | 70 | `other` / `soundcloud.app.goo.gl` |
| `vm.tiktok.com` | 9 | 30 | `tiktok` |
| `shorturl.at` | 5 | 25 | `other` |
| `hyperurl.co` | 3 | 24 | `other` |
| `fb.me` | 6 | 22 | `facebook` |
| `spotify.link` | 1 | 10 | `spotify` |
| `cutt.ly`, `ow.ly`, `rb.gy` | 1 | 16 | `other` |

`bit.ly`'s live count is 0 because 2d already resolves it — evidence the
mechanism works, just under-applied. Hosts staged under their own bare domain
(`ffm.to [as ffm.to]`) come from sync-linktree's unknown-domain fallback; they
can never be promoted, since those aren't keys in `platforms`.

---

## Grounding — probed live 2026-08-08

Every host was probed with a real request. **This is the part that shapes the
design**, because "follow the redirect and keep what comes back" is wrong for
more than half of them:

| Probe | Result | Verdict |
|---|---|---|
| `on.soundcloud.com/SGLfUfT6l0kTYyO1SY` | → `soundcloud.com/lolakind?ref=clipboard&…` | resolves cleanly |
| `soundcloud.app.goo.gl/N1oiE` | → `soundcloud.com/akrecords97/sets/lankoucore-dream-of-core?…` | resolves; needs handle extraction |
| `goo.gl/ugfBAL` | → `youtube.com/channel/UC_dO_-MSuK6zqjl4vpjfo2g` | resolves; **reclassifies** `other`→`youtube` |
| `spotify.link/eqRHE9U72Db` | → `spotify.app.link/eqRHE9U72Db?_p=…` | **worse than the original** — Branch deep link, not a profile |
| `vm.tiktok.com/ZSKeHLQN` | → `tiktok.com/?_r=1` | **worse than the original** — bot-blocked, lands on the homepage |
| `lnk.to/LVRAdeadSo` | 200 at the same URL | no redirect — JS landing page |
| `ffm.to/boka067` | 200 at the same URL | no redirect — JS landing page |

`spotify.link` and `vm.tiktok.com` were each confirmed across three separate
samples, so those are the steady-state behaviours, not flukes.

**Conclusion: destination validation is mandatory, not optional.** The existing
`resolveShareUrl` gets this right ("only trust a redirect that landed on
soundcloud.com"); the 2d resolver does not, and would cheerfully overwrite a
real TikTok profile with `tiktok.com/?_r=1`. The new library inherits
`resolveShareUrl`'s stricter posture for every host.

---

## Host tiers

The single table that replaces both `SHORTENER_HOSTS` and
`SOUNDCLOUD_SHARE_HOSTS`. Lives in the new module, next to but distinct from
`DOMAIN_PLATFORM_MAP`.

**Tier A — resolve, then require the destination to match an expected host.**
The target platform is known in advance, so anything else is a failed resolve
and the original is kept.

| Host | Must land on |
|---|---|
| `on.soundcloud.com` | `soundcloud.com` |
| `soundcloud.app.goo.gl` | `soundcloud.com` |
| `fb.me` | `facebook.com` |
| `spotify.link` | `open.spotify.com` — *will currently always fail; see below* |
| `vm.tiktok.com` | `tiktok.com` with a `/@handle` path — *ditto* |

`spotify.link` and `vm.tiktok.com` stay in Tier A deliberately even though they
fail today: the validation is what makes them safe to attempt, and if those
services ever start answering bots properly the rows resolve with no code
change. Until then they are correctly left alone rather than corrupted.

**Tier B — generic shorteners. Resolve, then reclassify by domain.** The
destination is unknowable by nature, so `classifyPlatformUrl` decides what it
turned out to be.

`bit.ly`, `goo.gl`, `tinyurl.com`, `shorturl.at`, `cutt.ly`, `ow.ly`, `rb.gy`,
`buff.ly`

**Tier C — explicitly NOT resolved.** Documented in the table with a reason, so
nobody adds them later thinking they were an oversight.

| Host | Why not |
|---|---|
| `lnk.to`, `ffm.to`, `smarturl.it`, `hyperurl.co` | Music smart-links. They return 200 at their own URL and fan out to many stores via JS — there is no single "real target" to resolve to. |
| `youtu.be` | Deterministic (`youtu.be/<id>` → `youtube.com/watch?v=<id>`), so no network call is warranted — and these are *video* links, not channels. Converting them wouldn't yield an artist profile. Separate concern. |
| `maps.app.goo.gl` | 1 staged row, a venue pin. Not an artist link; let it stay `other`. |

---

## Architecture

```
                    src/lib/resolve-url-redirects.ts        ← Tier table + network core
                                  │                            (pure: URL in, URL out)
                    ┌─────────────┴─────────────┐
                    │                           │
   src/lib/resolve-artist-links.ts        scripts/integrate-harvested-links.mjs
   (row-level policy for artist_links)    (2d — replaces resolveShortLink)
                    │
        ┌───────────┴────────────┐
        │                        │
   after() on save        scripts/resolve-link-redirects.mjs
   (4 form paths)         (backfill / drain)
```

Two modules, because the network core has no business knowing about Supabase,
and the row-level policy has no business re-implementing fetch.

### Module 1 — `src/lib/resolve-url-redirects.ts`

Server-only. **Not** added to `profile-links.ts`:
`src/components/ProfileLinkField.tsx` is a `"use client"` component importing
that module, so fetch-based resolver code sitting there is already one
tree-shaking regression away from shipping to the browser.

```ts
export interface ResolveResult {
  url: string;          // resolved, or the original on any failure
  resolved: boolean;    // did it actually change?
  finalStatus: number | null;  // status at the destination, when known
  reason?: "not-resolvable" | "no-redirect" | "validation-failed"
         | "timeout" | "network-error" | "max-hops";
}

export function isResolvableHost(url: string): boolean;
export async function resolveRedirect(
  url: string,
  opts?: { timeoutMs?: number; maxHops?: number; userAgent?: string }
): Promise<ResolveResult>;
```

- Never throws. Every failure path returns the original URL with a `reason`.
- Follows hops manually (`redirect: "manual"`, read `Location`) so the hop
  chain is inspectable and Tier A validation can run on the final URL.
- Reports `finalStatus` so callers can refuse to promote a resolved-but-dead
  target. This closes the gap where `soundcloud.app.goo.gl/Hqa78g…` resolves
  perfectly to `soundcloud.com/ahuraaghabeigi`, which 404s.
- Does **not** set a dispatcher. Scripts already register the HTTP/1.1-only
  one via `scripts/lib/http-dispatcher.mjs`; the web app keeps Node's default.

### Module 2 — `src/lib/resolve-artist-links.ts`

Server-only. Knows the `artist_links` row shape and the preserve convention.

```ts
export async function resolveArtistLinks(
  client: SupabaseClient,
  scope: { artistId: string } | { ids: number[] } | { all: true },
  opts?: { dryRun?: boolean; onProgress?: (r: RowOutcome) => void }
): Promise<{ updated: RowOutcome[]; skipped: RowOutcome[] }>;
```

Per row:

1. Skip unless `isResolvableHost(url)`.
2. `resolveRedirect(url)`; skip on failure or when `finalStatus` is 4xx/5xx.
3. Reclassify via `classifyPlatformUrl` (Tier B only — Tier A keeps its known
   platform).
4. Canonicalize via `resolveProfileLinkUrl`, and recompute `handle` with
   `deriveHandle` — the handle is derived from the *resolved* URL, so a
   deferred resolve must redo it.
5. Write `url`, `platform`, `handle`; set `original_url` to the pre-resolution
   URL **only if `original_url` is currently empty**, so a true original is
   never clobbered and re-runs stay idempotent (same rule as
   `resolve-residentadvisor-urls.mjs`).

**Unique-constraint hazard, handle explicitly.** `artist_links` carries
`UNIQUE (artist_id, platform)`. A Tier B resolve can change the platform —
`goo.gl [as other]` → `youtube` — onto a slot the artist already occupies.
That's a constraint violation, not a merge decision the script should make
silently. Such rows are skipped and reported to a datetime-stamped CSV,
mirroring 2d's existing "not found" collision convention.

---

## Call sites

### 1. Forms — resolve after the response, not before it

Save paths, all currently calling `resolveProfileLinkUrlAsync` inline:

| Path | File |
|---|---|
| Public submit | `src/app/api/submit/route.ts:265` |
| Edit form | `src/app/artist/[id]/edit/actions.ts:311` |
| Apply revision (admin) | `src/app/admin/actions.ts:369` |
| Missing-links tool (admin) | `src/app/admin/missing-links/actions.ts:41` |

The `revise` route (`src/app/api/revise/route.ts`) stores `revision_data` JSON
and saves no links, so it needs no change — revisions resolve when an admin
applies them, at the `admin/actions.ts` site above.

Today inline resolution is cheap because it fires only for `on.soundcloud.com`
on a single field. Once the form paths know the full host table, a submission
with five shortened links becomes five sequential network calls on the critical
path. So the save writes links as-is and schedules the work:

```ts
import { after } from "next/server";
// … save links …
after(() => resolveArtistLinks(admin, { artistId }));
```

`after` is stable in the installed Next 16 (`next/server`), runs post-response
in the same invocation, and needs no new infrastructure on Vercel.

Accepted consequence: the page rendered right after the save shows the
unresolved URL until revalidation. Either call `revalidatePath` at the end of
the callback or let it be — it's a link tidying itself, not a correctness
issue. Recommend letting it be, and revisiting if it looks odd in practice.

**`src/lib/submission-helpers.ts:153` stays inline.** That call is duplicate
*detection* — it resolves a submitted link to match it against existing
artists before deciding whether to accept the submission. Deferring it would
defeat its purpose. It keeps its 5 s timeout; it just calls the new library.

### 2. `integrate-harvested-links.mjs` (2d)

Delete `SHORTENER_HOSTS`, `isShortenerUrl`, `followOneRedirect`,
`resolveShortLink`, `MAX_REDIRECT_HOPS` and the module-level `resolveCache`
(lines ~396–455, i.e. `SHORTENER_HOSTS` at :405 through `resolveShortLink`
at :442); call the library instead. The surrounding step at ~544–580
keeps its current shape — batch, 150 ms throttle, persist back to
`artist_harvested_links` so resolution is a one-time cost per row.

Two behaviour changes, both deliberate:

- Resolution now covers all Tier A + B hosts, not just `bit.ly`. The big one is
  `on.soundcloud.com`: **523 staged rows** that the forms path would have
  resolved but 2d never did.
- The staging row currently discards the short URL (`row.raw_url = resolved`,
  "drop the bit.ly clutter"). Per the preserve decision, `raw_url` now keeps
  the original and only `parsed_url` gets the resolved value.

The existing post-resolution dedup on `(artist_id, parsed_url)` already handles
two shorteners collapsing to one target, so widening the host list needs no new
collision logic there.

### 3. `scripts/resolve-link-redirects.mjs` — new backfill

Modelled on `resolve-residentadvisor-urls.mjs`. Thin: argument parsing, scope
selection, reporting. All logic lives in Module 2.

```bash
npm run resolve-link-redirects -- --dry-run      # report only
npm run resolve-link-redirects                   # live rows
npm run resolve-link-redirects -- --host=goo.gl  # one host
```

**No queue table.** The set of rows needing resolution is exactly "rows whose
host is in the tier table" — fully derivable from the URL. This query *is* the
queue and this script *is* the drain, so `after()` and the backfill can't drift
out of sync, and adding a host to the table automatically re-enqueues history.

This also absorbs the original 16 `goo.gl` / `soundcloud.app.goo.gl` rows in
`artist_links` — they need no separate one-off. Registered in `package.json`
under `tsx` (it imports TypeScript from `src/lib`, so plain `node` can't run
it).

The `AFTER UPDATE OF url` trigger `clear_enrichment_on_url_change` fires on
every rewrite. Checked: it only nulls `sync_error` and `follow_graph_built_at`
for that artist+platform, which is exactly right — it forces a re-sync against
the corrected URL. No bios, images, or genres are touched.

---

## Testing

- `src/lib/resolve-url-redirects.test.ts` — tier membership, hop following, hop
  cap, Tier A validation accept/reject, timeout, network error, and the
  never-throws contract. Network mocked, following the existing `resolveShareUrl`
  tests in `profile-links.test.ts:590`.
- `src/lib/resolve-artist-links.test.ts` — `original_url` preserve-if-empty,
  handle recomputation, dead-destination skip, platform-collision skip,
  dry-run writes nothing, idempotent re-run.
- Regression: the `resolveShareUrl` / `resolveProfileLinkUrlAsync` cases in
  `profile-links.test.ts` must keep passing unchanged — the on.soundcloud.com
  behaviour is the reference the new library is generalising, not replacing.
- Live: `--dry-run` over all of `artist_links` before any write, and
  `DRY_RUN=1 npm run integrate-harvested-links` before a real 2d run.

## Order of work

1. Module 1 + tests. Self-contained, no callers yet.
2. Module 2 + tests.
3. Backfill script; `--dry-run` over live data and read the report. **Stop and
   review the numbers here** — this is the checkpoint before anything mutates
   `artist_links`.
4. Rewire 2d. `DRY_RUN=1`, compare against the dry-run report.
5. Rewire the four form paths to `after()`; leave submission-helpers inline.
6. Run the backfill for real.
7. Document in `PIPELINE.md` — the tier table is the part future-me will look
   for.

Steps 1–2 are pure addition and can land without behaviour change. Every step
after 3 is independently revertible.

## Open questions

1. **Should the backfill run on a schedule?** It's the safety net for a dropped
   `after()`. Options: an orchestrator stage, a Vercel cron, or manual. Manual
   is fine to start — the volume is tiny — but it means a failed `after()` sits
   unresolved until someone remembers.
2. **Tier B `other` → real platform is a visible change.** Ten live `goo.gl`
   rows sitting in `other` will become `youtube`, `bandcamp`, etc., which moves
   them into their proper slot on the artist page. Desirable, but worth
   eyeballing the dry-run list before it happens.
3. **`youtu.be` (166 live, 976 staged) is the biggest cohort here** and this
   plan deliberately excludes it. They're video links stored as `youtube`. The
   real question — should a video link count as an artist's YouTube presence,
   or should it be `other`/dropped? — is a data-model call, not a resolution
   one. Flagging it as follow-up work.
