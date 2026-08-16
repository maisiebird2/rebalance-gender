# URL redirect resolution — implementation plan

One shared library for "this URL's true target is only knowable over the
network", called from three places: the form save paths, the harvested-link
promoter (2d), and a new backfill over `artist_links`.

Status: **steps 1–5 of 7 done** — both modules, the backfill script, the 2d
rewiring and the form paths are implemented and tested. **Nothing has been
written to `artist_links` or `artist_harvested_links` yet**: the backfill and
2d have only ever been dry-run. The form paths are now wired, so the first
real writes will happen when someone saves a link through the app — everything
else waits for step 6. Branch `resolve-url-redirects`,
rebased onto `origin/main` at `3f9f11b` after the repo reorganisation (PR #86)
moved this document from `scripts/` to `documentation/`.

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

| | `resolveShareUrl`<br>`src/lib/profile-links.ts:739` | `resolveShortLink`<br>`scripts/integrate-harvested-links.mjs:443` |
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

**Implemented**, with 34 tests in `src/lib/resolve-url-redirects.test.ts`. As
built:

```ts
export type HostTier = "validate" | "reclassify";

export interface ResolveResult {
  url: string;          // resolved, or the original on any failure
  resolved: boolean;    // did it actually change?
  tier: HostTier | null;        // null when the host isn't resolvable
  destination: string | null;   // final URL reached, even when rejected
  finalStatus: number | null;   // status at the destination, when known
  reason?: "not-resolvable" | "no-redirect" | "validation-failed"
         | "dead-destination" | "max-hops" | "timeout" | "network-error";
}

export function isResolvableHost(url: string): boolean;
export function hostTier(url: string): HostTier | null;
export function hostExpectation(url: string): string | null;
export const NOT_RESOLVED_HOSTS: ReadonlyMap<string, string>;  // tier C + why
export async function resolveRedirect(
  url: string,
  opts?: { timeoutMs?: number; maxHops?: number; userAgent?: string }
): Promise<ResolveResult>;
```

Four additions to the interface sketched above, all of which Module 2 needs:

- `tier` — so a caller knows whether to re-run classification (Tier B) or keep
  the platform it already had (Tier A), without re-deriving the host.
- `destination` — the final URL even when it was rejected, so a failure report
  can say what a link pointed at. Deliberately separate from `url` so that
  value can never be mistaken for a usable result.
- `dead-destination` — split out from the generic failure reasons, because
  "resolved fine, but the target 404s" is the one case a backfill must not act
  on, and it needs to be distinguishable in a report.
- `NOT_RESOLVED_HOSTS` — the Tier C table, exported for documentation rather
  than runtime use. A test asserts every host in it is non-resolvable, so
  promoting one to Tier B has to be a deliberate act.

Two behaviours worth recording, both discovered while writing the tests:

- **Timeout bounds the whole chain, not each hop.** One `AbortController` spans
  every request, so a 5-hop chain can't quietly cost `maxHops × timeoutMs`.
- **A self-redirect is reported as `max-hops`, not `no-redirect`.** Hops are
  counted rather than inferred from "did the URL change", so a URL redirecting
  to itself is described as the loop it is instead of looking like a host that
  never redirected.

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

**Implemented**, with 25 tests in `src/lib/resolve-artist-links.test.ts`.

```ts
export async function resolveArtistLinks(
  client: SupabaseClient,
  scope: { artistId: string } | { ids: number[] } | { all: true },
  opts?: {
    dryRun?: boolean; host?: string; limit?: number; delayMs?: number;
    resolve?: ResolveOptions; onProgress?: (r: RowOutcome) => void;
  }
): Promise<{ updated: RowOutcome[]; skipped: RowOutcome[]; examined: number }>;
```

Per row:

1. Skip unless `isResolvableHost(url)`.
2. `resolveRedirect(url)`; skip on failure or when `finalStatus` is 4xx/5xx.
3. Reclassify via `classifyPlatformUrl` — **both tiers**; see below.
4. Canonicalize via `resolveProfileLinkUrl`, and recompute `handle` with
   `deriveHandle` — the handle is derived from the *resolved* URL, so a
   deferred resolve must redo it.
5. Write `url`, `platform`, `handle`; set `original_url` to the pre-resolution
   URL **only if `original_url` is currently empty**, so a true original is
   never clobbered and re-runs stay idempotent (same rule as
   `resolve-residentadvisor-urls.mjs`).

Reads are paged and pre-filtered in SQL with a loose `url ILIKE %host%` per
known host (built from `resolvableHosts()`), so the `{ all: true }` scan
touches ~57 rows rather than pulling all 200k. Survivors are re-tested with
`isResolvableHost`, which matches exactly — that's what keeps
`maps.app.goo.gl` untouched while `soundcloud.app.goo.gl` resolves.

### Reclassification policy — corrected by the first dry run

The plan originally said "Tier B only — Tier A keeps its known platform". **That
was wrong**, and the live dry run showed it immediately:

```
UPDATE  #179196  other -> other
          https://soundcloud.app.goo.gl/TTQjJ
        -> https://soundcloud.com/kling_und_klang   handle=null
```

The reasoning confused "we knew what the destination would be" with "the stored
platform is right". A `soundcloud.app.goo.gl` row sits under `other` *precisely
because* classification ran on the shortener host before anything could resolve
it. Keeping that platform leaves an obvious SoundCloud profile filed as `other`
with a null handle. 11 of 31 proposed updates were affected.

So **both tiers reclassify**, with one guard: `"other"` is the classifier's
fallback, not a finding, so it never overrides what's already stored. Without
that guard a `bit.ly` filed under `homepage` resolving to a personal site would
be *downgraded* to `other`, losing real information — and `homepage`, `djanes`,
`1001tracklists` and `hoer` are all platform keys outside the shared domain
table, so this is not hypothetical.

**Unique-constraint hazard, handled explicitly.** `artist_links` carries
`UNIQUE (artist_id, platform)`. A resolve can change the platform —
`goo.gl [as other]` → `youtube` — onto a slot the artist already occupies.
That's a constraint violation, not a merge decision the module should make
silently, so such rows are skipped and reported. Fixing the reclassification
policy above raised the count from 2 to 5, since three newly-identified
SoundCloud rows turned out to belong to artists who already have a SoundCloud
link. Slots claimed *during* a run are tracked too, so two rows in one batch
can't both take the same platform.

### First live dry run — 2026-08-11

Read-only, over all of `artist_links`. **57 examined, 28 would update, 29
skipped.**

| Skip reason | Rows |
|---|---:|
| `validation-failed` | 10 |
| `dead-destination` | 9 |
| `duplicate-of-existing` | 3 |
| `platform-collision` | 2 |
| `no-redirect` | 4 |
| `network-error` | 1 |

| Platform move | Rows |
|---|---:|
| `soundcloud` → `soundcloud` | 9 |
| `other` → `other` | 8 |
| `facebook` → `facebook` | 6 |
| `other` → `youtube` | 2 |
| `other` → `instagram` / `spotify` / `facebook` | 3 |

The 19 `validation-failed` + `dead-destination` skips are the design working:
every one of those would have been a live row overwritten with a Branch deep
link, a TikTok homepage, or a 404. The 8 `other` → `other` rows are genuinely
generic — Google Docs/Forms, Dropbox, Mixmag, Jotform — so they keep their
platform and just get a durable URL in place of a shortener.

The five one-slot-two-links cases were originally reported as a single
`platform-collision` reason. Adding the incumbent's URL to the report showed
that was conflating two unrelated situations: three were exact duplicates
(the resolved URL is character-for-character what the artist's existing link
holds — redundant rows, mechanical cleanup) and only two were genuine
contests. Hence the `duplicate-of-existing` split. The two real ones were:

| Artist | Resolves to | Incumbent holds |
|---|---|---|
| Gud | `youtube.com/channel/UC_dO_-MSuK6zqjl4vpjfo2g` | `youtube.com/watch?v=gG53f7OAiQk` |
| Leo Lingus | `soundcloud.com/kling_und_klang` | `soundcloud.com/leolingus` |

**Both were resolved by hand in the live database on 2026-08-15**, after this
run — so a re-run will report fewer than 2 collisions. The counts above are
as-of the run, not a current-state description. Nothing else here has been
written; `artist_links` is otherwise untouched.

---

## Call sites

### 1. Forms — resolve after the response, not before it

**Done.** All four save paths now store the synchronously-canonicalized URL and
schedule the network step for after the response:

| Path | File | Client passed to `after()` |
|---|---|---|
| Public submit | `src/app/api/submit/route.ts` | `supabase` (admin) |
| Edit form | `src/app/artist/[id]/edit/actions.ts` | `admin` |
| Apply revision (admin) | `src/app/admin/actions.ts` | `admin` |
| Missing-links tool (admin) | `src/app/admin/missing-links/actions.ts` | `admin` |

Each switched from `await resolveProfileLinkUrlAsync(...)` to the plain
synchronous `resolveProfileLinkUrl(...)`, then calls
`scheduleLinkResolution(client, artistId)` once the rows are written.

The `revise` route (`src/app/api/revise/route.ts`) stores `revision_data` JSON
and saves no links, so it needed no change — a revision's links first become
real rows when an admin approves it, at the `admin/actions.ts` site above.

Inline resolution used to be cheap: one network call, only for
`on.soundcloud.com`, only on the SoundCloud field. At the full host table a
submission with five shortened links would have meant five sequential
round-trips before the user saw anything. `after()` is stable in the installed
Next 16, runs post-response in the same invocation, and needs no new
infrastructure on Vercel. The codebase already used it for image scraping, so
`scheduleLinkResolution` follows that convention (`after(async () => { try …
catch }`) — an unhandled rejection in a detached callback would otherwise
surface as a server error for a save that already succeeded.

`scheduleLinkResolution` lives in its own module rather than in
`resolve-artist-links.ts`, because that module is imported by `scripts/` under
tsx and importing `next/server` there would drag the framework into a plain
Node script.

Accepted consequence: the page rendered right after the save shows the
unresolved URL until revalidation. Left alone deliberately — a link tidying
itself a beat later is not a correctness problem.

#### Duplicate detection: inline, but no longer half-blind

`src/lib/submission-helpers.ts` still resolves inline, because it has to know
where a submitted link really points BEFORE deciding whether the artist already
exists. Deferring it would defeat the purpose. It keeps its 5 s timeout.

What changed is what it can see. `resolveShareUrl` now delegates to the shared
resolver instead of carrying its own `redirect: "follow"` implementation and its
own one-host list, and `resolveProfileLinkUrlAsync` gates on **the host** rather
than on `platformKey === "soundcloud"`. Both were silently narrowing dup
detection: a submitted `soundcloud.app.goo.gl` or `bit.ly` link was never
resolved, so it was compared as a shortener against stored canonical URLs, never
matched, and a duplicate artist could be created for someone already in the
directory. A shortener typed into a non-SoundCloud field was ignored for the
same reason.

`SOUNDCLOUD_SHARE_HOSTS` survives in `profile-links.ts` but narrowed to one job:
the *synchronous* guard `isSoundcloudShareLink`, which stops
`normalizeProfileLink` mangling an unresolved share link's opaque id into a
bogus `soundcloud.com/<id>`. That guard runs on the client, so it stays
dependency-free.

This makes `profile-links.ts` import `resolve-url-redirects.ts` — its only
import. `ProfileLinkField.tsx` is a `"use client"` component that imports this
module, so the boundary matters: everything reachable from the sync exports is
still pure string work, and `npm run build` compiles clean.

### 2. `integrate-harvested-links.mjs` (2d)

**Done.** `SHORTENER_HOSTS`, `isShortenerUrl`, `followOneRedirect`,
`resolveShortLink`, `MAX_REDIRECT_HOPS` and the module-level `resolveCache` are
gone — about 60 lines of bespoke resolver replaced by a call to the library.
The surrounding step keeps its shape: batch, 150 ms throttle, persist back to
`artist_harvested_links` so resolution is a one-time cost per row.

Three behaviour changes, all deliberate:

- Resolution now covers all Tier A + B hosts, not just `bit.ly`. Measured on
  the staging table: **1,312 rows** now qualify, against 306 before.
- `raw_url` is no longer clobbered. It used to be overwritten with the resolved
  value ("drop the bit.ly clutter"); per the preserve decision it keeps the
  link exactly as scraped, and only `parsed_url` carries the destination.
- Reclassification no longer uses `CLASSIFY_CONFIGS.harvested_links`. See below
  — this one was forced.

The existing post-resolution dedup on `(artist_id, parsed_url)` already handles
two shorteners collapsing to one target, so widening the host list needs no new
collision logic there.

#### The skip config had to go

`harvested_links` skips `soundcloud.com`, because a link back to SoundCloud
found *on* a SoundCloud page is a self-link. That reasoning is about where a
link was **found**, and it does not survive resolution, where the question is
where the URL actually **goes**. Keeping it would have been destructive at the
new host coverage: all 523 staged `on.soundcloud.com` rows resolve to
`soundcloud.com`, so the skip would have nulled their `parsed_platform` and
stranded rows that promote correctly today. The self-link skip still applies
where it belongs — at harvest time, via each harvester's own config.

That call site was the only user of `CLASSIFY_CONFIGS.harvested_links`, which
is now unreferenced (its own test still covers it). Worth deciding separately
whether to delete the config.

#### One policy, shared — and a leak it closed

Reclassification-after-resolution now lives in **one** place,
`reclassifyResolvedUrl()` in `classify-platform-url.ts`, used by both 2d and
`resolve-artist-links.ts`. The first cut of this step had a private copy in the
script, which is exactly the duplication this project exists to remove — and
the copy was already wrong. It collapsed "no rule matched" and "policy
refuses this host" into one branch, so a shortener resolving to Twitter/X
would have kept its platform and stored the URL, laundering an excluded link
into a promotable one. The dry run caught two live instances:

```
resolved http://bit.ly/2MVYUDL -> https://twitter.com/dijondijon_ (platform: other)
resolved http://bit.ly/2noZyjE -> https://twitter.com/swinetax  (platform: other)
```

The shared version returns three outcomes instead of two — `refused`, keep the
existing key, or take a positive identification — so those rows now stay as
`bit.ly` and are counted under a `destination-not-storable` reason.

#### Dry run — 2026-08-16

Snapshot, not a steady state: the staging table changes constantly, and the
classification half of this run predates the shared-policy fix above.

**1,312 rows had a resolvable host; 1,055 resolved, 257 left as-is.**

| Left as-is | Rows |
|---|---:|
| `dead-destination` | 149 |
| `no-redirect` | 57 |
| `validation-failed` | 36 |
| `network-error` | 8 |
| `timeout` | 4 |
| `max-hops` | 3 |

The 149 dead destinations are the single biggest category, which is the point
of resolving staging rows before promoting them: each is a link that would
otherwise have been promoted into `artist_links` pointing at a 404.

**Unrelated pre-existing finding.** The same run reported *101,852* pairs
awaiting insertion into `artist_links` against 55,897 already linked. That is
not caused by this change — resolution only touches the 1,312 resolvable-host
rows, so at most that many of the 101,852 could be attributable to it. It looks
like a large unpromoted staging backlog, i.e. 2d has not been run to completion
in a long time. Flagged as its own question, not part of this work.

### 3. `scripts/resolve-link-redirects.mjs` — new backfill

**Implemented.** Modelled on `resolve-residentadvisor-urls.mjs`. Thin:
argument parsing, scope selection, reporting. All logic lives in Module 2.

```bash
npm run resolve-link-redirects -- --dry-run         # report only, no writes
npm run resolve-link-redirects                      # rewrite live rows
npm run resolve-link-redirects -- --host=goo.gl     # one host only
npm run resolve-link-redirects -- --artist=<uuid>   # one artist
npm run resolve-link-redirects -- --ids=12,34       # specific artist_links rows
npm run resolve-link-redirects -- --limit=20        # cap rows examined
npm run resolve-link-redirects -- --delay=300       # ms between network calls
npm run resolve-link-redirects -- --debug           # log every row's decision
DRY_RUN=1 npm run resolve-link-redirects            # same as --dry-run
```

Every run writes a CSV of **every row it examined** — proposed changes and
skips with their reasons — through `outputPath()`, so it lands in the sibling
`output files/` folder rather than the checkout. Columns: status, reason,
artist name, artist edit URL, link id, platform → new platform, url → new url,
new handle, the destination actually seen, and its HTTP status. In a dry run
that CSV is the point of the exercise. Nothing to resolve means no CSV.

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

1. ~~Module 1 + tests. Self-contained, no callers yet.~~ **Done.** Verified
   against the live network as well as the mocked tests: all ten probe cases
   behaved exactly as the grounding section predicts, including both
   validation rejections and the dead `soundcloud.app.goo.gl` destination.
2. ~~Module 2 + tests.~~ **Done.** A dry run over live data was used as the
   verification, and it corrected the reclassification policy (above).
3. ~~Backfill script; `--dry-run` over live data and read the report.~~
   **Script done; awaiting review.** It reproduces the Module 2 dry-run numbers
   exactly (57 examined / 28 would update / 29 skipped) and the report is at
   `output files/link-redirect-resolution-20260815-212047.csv`.
   **← STOP HERE.** This is the checkpoint: nothing has mutated `artist_links`
   yet, and step 6 is the first thing that will.
4. ~~Rewire 2d. `DRY_RUN=1`, compare against the dry-run report.~~ **Done.**
   Also extracted `reclassifyResolvedUrl` so 2d and Module 2 share one
   reclassification policy rather than two copies.
5. ~~Rewire the four form paths to `after()`; leave submission-helpers inline.~~
   **Done.** Also pointed `resolveShareUrl` at the shared resolver, which
   widened duplicate detection from one host to all of them.
   **Not verified end-to-end**: exercising a save means writing to the live
   database, which step 6 is the first sanctioned point for. Verified as far as
   is possible without that — `npm run build` compiles (the client/server
   boundary is the real risk here), pages render 200 at runtime, 397 tests,
   tsc and eslint clean.
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
