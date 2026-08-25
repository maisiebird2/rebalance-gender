# Proposal — embed each artist's most recent HÖR set

> **Status: proposal, not accepted.** Written 2026-08-24 from a design
> discussion. Nothing here is built. The findings in
> [What we verified](#what-we-verified) are empirical — they were measured
> against hoer.live and YouTube on the day of writing — and three of them
> shape everything after: hoer.live cannot be framed at all; an artist page
> carries two different players and the obvious regex finds the wrong one; and
> the broken embeds on HÖR's own pages are a missing **thumbnail rendition**,
> not a dead video. Read that section before the plan.

---

## The goal

Every artist page that has a bound HÖR identity should carry **one** embedded
video: **the artist's most recent HÖR set**. One embed, not a grid — the page
already carries a Bandcamp player and up to three SoundCloud widgets
([`page.tsx`](../src/app/artist/[id]/page.tsx)), and a fourth media block
competing for attention would be a lot.

"Most recent" is a **derived** property, not a stored choice: when a crawl
discovers a newer set by the same artist, the page shows the new one on the
next request with no backfill step. That falls out of the storage shape in
[Data model](#data-model).

---

## What we verified

Six things were measured against hoer.live and YouTube rather than assumed.
Four of them changed the plan.

### 1. hoer.live cannot be embedded at all

```
$ curl -sI https://hoer.live/trujillo-hor-august-24-2026/
x-frame-options: SAMEORIGIN
```

Every hoer.live page refuses to be framed by a third-party origin. There is no
"embed the HÖR player directly" option, on any page, for anyone. **YouTube is
the only route.** This is not a preference; it is the whole decision.

### 2. Two different players live on an artist page — only one is the artist's

This is the finding that answers "why do some HÖR pages show an embed that
doesn't work", and getting it wrong is easy, because `/artist/<slug>/` renders
**two unrelated players** and the obvious regex finds the wrong one.

**The sticky player — not the artist's.** The `videoId: '…'` in the page's
inline script belongs to `main-video__player_sticky`, the corner panel headed
*"Now Playing"*, which also writes a `current=…` cookie. It is HÖR's
site-wide radio, re-drawn per request and identical in kind on every page.
Sampled across nine artist pages it showed a different artist's set every
time. **Never read the video ID from `videoId:`.**

**The show cards — the artist's own sets.** Inside `<div id="artist-shows">`,
each set is a `show-card` carrying both halves of the mapping we want:

```html
<a data-show-id="4505" href="https://hoer.live/regina-leather-july-21-8pm-9pm/">
  <img src="https://i3.ytimg.com/vi/SiWwESb_W-o/maxresdefault.jpg" …>
```

`data-show-id` is the **WP post id** — the primary key of `hoer_sets` — and
the thumbnail URL carries the **YouTube video ID**. One fetch of the artist
page yields `post_id → video_id` for all of that artist's sets, correctly
attributed.

Checked against the REST API for six artists, the card list matched the set
list exactly for five of them (1, 8, 4, 2 and 5 sets). The sixth is instructive
and is [finding 5](#5-some-sets-in-the-api-have-no-video-or-no-page).

### 3. The set page is the authoritative fallback

Where a card is absent, the set page carries the ID inline:

```js
player = new YT.Player('player', { videoId: 'fIHTqo4sMS8', … })
```

On a **set** page — unlike an artist page — that player *is* the set's own
video. Every cheaper source was checked and rejected:

| Source | Result |
|---|---|
| WP REST `meta` | ✗ Exposes only `_acf_changed` and `footnotes`. The real field is the ACF meta key `youtube_id`, which is not registered for REST. |
| WP REST `content.rendered` | ✗ Empty string on every set post sampled. |
| ACF REST (`/wp-json/acf/v3/posts/<id>`) | ✗ `rest_no_route`, 404. |
| Set page HTML | ✓ One regex on `videoId: '…'`. |

That `youtube_id` key matters for a second reason: HÖR's own load-more endpoint
queries posts with `{"key":"youtube_id","compare":"!=","value":"0"}` —
**HÖR itself treats `youtube_id = 0` as "this set has no video"**, and omits
such sets from the card list.

### 4. The real cause of broken embeds: HÖR asks for a thumbnail that doesn't exist

The show cards hardcode **`maxresdefault.jpg`** (1280×720). YouTube only
generates that size when the source upload was at least that large — otherwise
it **404s**, and the card renders as a broken image with nothing to click.

Across the 33 videos sampled:

| Thumbnail | Present |
|---|---|
| `maxresdefault.jpg` (1280×720) | 30/33 |
| `sddefault.jpg` (640×480) | 30/33 |
| **`hqdefault.jpg` (480×360)** | **33/33** |

Regina Leather's set is one of the three. Her card requests
`i3.ytimg.com/vi/SiWwESb_W-o/maxresdefault.jpg` → **404**, while
`hqdefault.jpg` → **200**, and the video itself is public and embeddable. Her
set is fine; HÖR is asking for a rendition of the thumbnail that was never
made.

**So: always request `hqdefault.jpg`.** It was present for every video tested,
and it is the one rendition YouTube appears to generate unconditionally. This
single choice is what stops us reproducing the failure that prompted this
document.

### 5. Some sets in the API have no video, or no page

Marie Lung has 10 sets in the REST API and 9 show cards. The missing one,
post `70709` (2023-11-10), is not a pagination cut-off — it sits between two
sets that *are* carded. Its page is dead:

```
$ curl -sI https://hoer.live/marie-lung-hor-november-10-2023/
302 → https://hoer.live/404/
```

This is the same `302 → /404/` dead-link fingerprint already known from the
pending-HÖR export work. Combined with the `youtube_id = 0` case, it means
**a set existing in `hoer_sets` does not imply a video exists**, and it is
specifically possible for an artist's *newest* set to be the one without a
video. The fallback chain is not decoration; it is load-bearing.

Usefully, the card list already excludes both cases — HÖR only cards sets that
have a video and a live page.

### 6. The videos themselves are healthy

32 sets sampled across the full archive, four per year from 2019 to 2026,
resolving each set page's video ID and then probing YouTube:

```
total 32 | no videoId: 0 | oembed != 200: 0 | not embeddable: 0
```

All 32 returned `playabilityStatus.status = "OK"` and `playableInEmbed = true`.
Nothing in the archive is currently unembeddable. That is not a guarantee for
9,500 videos over time — videos get deleted, privatised, region-locked or have
embedding switched off after harvest — so the plan validates anyway; see
[Guarding against dead embeds](#guarding-against-dead-embeds).

---

## Data model

Two layers, because the HÖR tables are deliberately unreadable by the public
site: `hoer_sets` and `hoer_terms` have RLS on with **no anon policy**
(see [`supabase_migration_hoer_library.sql`](../migrations/supabase_migration_hoer_library.sql)).

### Internal — extend `hoer_sets`

```sql
ALTER TABLE public.hoer_sets
  ADD COLUMN IF NOT EXISTS youtube_video_id  text,
  ADD COLUMN IF NOT EXISTS video_status      text,
  ADD COLUMN IF NOT EXISTS video_checked_at  timestamptz;
```

`video_status` ∈ `ok` | `none` | `removed` | `private` | `not_embeddable` |
`unknown`. `none` is the legitimate `youtube_id = 0` case from finding 2, and
is a **converged** state — it must not be retried forever, the same discipline
`scraped_at` already enforces for terms.

### Public — a narrow projection table

Mirror `artist_bandcamp_albums`, which the artist page already joins in
[`queries.ts`](../src/lib/queries.ts):

```sql
CREATE TABLE public.artist_hoer_sets (
  artist_id     uuid NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  post_id       bigint NOT NULL,
  video_id      text NOT NULL,
  title         text,
  set_url       text,
  published_at  timestamptz NOT NULL,
  PRIMARY KEY (artist_id, post_id)
);
```

Anon-readable, service-role-written. Only rows with `video_status = 'ok'` are
projected into it, so **the public table contains no known-broken video by
construction** — the site never has to reason about health at render time.

### Why store every set when only one is shown

Three reasons, and they are the reason not to collapse this to a single
`artists.hoer_video_id` column:

1. **"Most recent" stays derived.** The page runs
   `order by published_at desc limit 1`. A newer set appears the moment the
   crawler inserts it; there is no second pass to update a pointer, and no way
   for the pointer to go stale.
2. **It gives the fallback a place to fall back to.** If the newest set's video
   dies, the next-newest healthy one is already in the table
   ([Guarding against dead embeds](#guarding-against-dead-embeds)).
3. **b2b sets work for free.** ~5% of sets credit two or more artists, and
   `term_ids` is an array precisely for that. One video row legitimately
   belongs to several artists, and a composite key on `(artist_id, post_id)`
   expresses that; a single column on `artists` cannot.

---

## Harvest pipeline

A new script, `scripts/harvest-hoer-videos.mjs`, reusing the existing throttled
`hoerFetch` and the HTTP/1.1 dispatcher.

**Read the show cards, not the set pages.** Parsing `#artist-shows` gives every
one of an artist's `post_id → video_id` pairs from a **single** request — and
[`enrich-hoer-terms.mjs`](../scripts/enrich-hoer-terms.mjs) already fetches
that exact URL for the portrait and socials. Extending its parser in
[`hoer-page.mjs`](../scripts/lib/hoer-page.mjs) makes the common case cost
**zero extra requests**. Set-page scraping drops to a fallback for a set that
has no card but is believed to have a video.

1. **Select work.** Terms with a non-null `artist_id` whose sets have no
   `video_checked_at`.
2. **Parse the cards** from the artist page — `data-show-id` → post id,
   thumbnail path → video id. Ignore `videoId:` entirely (finding 2).
3. **Reconcile against `hoer_sets`.** A set with no card is `video_status =
   'none'` — it has `youtube_id = 0` or a dead page (finding 5). Both are
   **converged** states, not retries, the same discipline `scraped_at` already
   enforces for terms.
4. **Validate** the video IDs that were found, write `youtube_video_id` /
   `video_status` / `video_checked_at`.
5. **Project** `ok` rows into `artist_hoer_sets`; delete rows that stop being
   `ok`.

Steps 4–5 also run standalone as a revalidation pass.

### On trusting HÖR's card list

The cards are HÖR's own rendering, so in principle they could omit a set that
does have a usable video. In the six artists checked, the only omission was a
genuinely dead set, so the list looks trustworthy — and its filtering is a
feature, since it excludes exactly the sets we could not embed anyway. The
reconciliation in step 3 means a wrongly-omitted set is recorded as `none`
rather than silently lost, so the assumption is auditable after the fact.

## Guarding against dead embeds

Four layers, cheapest first. The user-visible contract is: **an artist page
shows a working video or shows no video block at all — never a broken player.**

### Layer 0 — ask for a thumbnail that exists

Request **`hqdefault.jpg`**, never `maxresdefault.jpg`. This is the whole of
finding 4, and it is the single most important line in this document: it is
the difference between reproducing HÖR's broken cards and not. ~9% of the
sampled archive (3 of 33) has no `maxresdefault` rendition.

### Layer 1 — validate at harvest (no API key)

`https://www.youtube.com/oembed?url=…&format=json`, one unauthenticated GET:

| Response | Meaning | `video_status` |
|---|---|---|
| `200` | Video exists and is public | continue to layer 2 |
| `401` | Private | `private` |
| `404` | Deleted, or never existed | `removed` |

### Layer 2 — confirm it is actually embeddable

**A 200 from oEmbed does not mean the video can be embedded.** Uploaders can
disable third-party playback, and region restrictions do not show up in oEmbed
at all. Two ways to close that gap:

- **Without an API key** — parse `playableInEmbed` out of the watch page's
  `ytInitialPlayerResponse`. This is what the 32-set probe used, and it worked,
  but it is scraping an undocumented blob and will break when YouTube changes
  it.
- **With an API key (recommended)** — `videos.list?part=status,contentDetails`
  returns `status.embeddable`, `status.privacyStatus` and
  `contentDetails.regionRestriction` as a documented contract. It costs **1
  quota unit per call and accepts 50 IDs per call**, so validating the entire
  archive is ~190 units against a 10,000/day allowance. There is no
  `YOUTUBE_API_KEY` in `.env.local` today; adding one is a small cost for a
  supported interface, and the same key would make the periodic revalidation in
  layer 4 trivial.

### Layer 3 — fall back at render, then hide

The page query asks for the newest **healthy** set, which is not always the
newest set — finding 5 showed an artist whose second-newest set has no video
at all, and a newest-set-only design would have shown that artist nothing. If
an artist has no healthy set, the component returns `null` and the page renders
exactly as it does today. This is the same posture the SoundCloud widget
already takes when `track_count === 0` — suppress rather than embed something
empty.

### Layer 4 — revalidate on a schedule

Only the **displayed** video needs re-checking: one video per artist with a
HÖR binding, which with a batched API call is a handful of requests for the
whole directory. Re-run monthly, or fold it into the existing HÖR sync. A video
that turns unhealthy is demoted out of `artist_hoer_sets` and the fallback in
layer 3 promotes the next one automatically.

---

## Rendering

A `HoerSetWidget` component beside
[`BandcampWidget.tsx`](../src/components/BandcampWidget.tsx), rendered in the
same media stack on the artist page.

**Use a click-to-load facade, not a live iframe.** A YouTube iframe pulls well
over a megabyte and runs third-party script before anyone presses play, on a
page that may already be running a Bandcamp player and three SoundCloud
widgets. Render **`https://i.ytimg.com/vi/<id>/hqdefault.jpg`** with a play
control, and swap in the iframe on click with `autoplay=1`.

`hqdefault` is not a resolution compromise made for weight — it is
[finding 4](#4-the-real-cause-of-broken-embeds-hör-asks-for-a-thumbnail-that-doesnt-exist).
`maxresdefault` is what HÖR requests and what 404s on ~9% of the archive. At
480×360 upscaled into a card, `hqdefault` is adequate; a broken image is not.
If a sharper facade is wanted later, probe `maxresdefault` at harvest and
store which renditions exist rather than guessing at render time.

Point the iframe at **`https://www.youtube-nocookie.com/embed/<id>`**, which
matches the privacy posture of the rest of the site.

**One CSP change** — [`proxy.ts`](../src/proxy.ts) needs
`https://www.youtube-nocookie.com` added to `frame-src`, which is currently
exactly three hosts. `img-src` is already `'self' data: blob: https:`, so the
thumbnail needs nothing. Per [SECURITY-HEADERS.md](SECURITY-HEADERS.md), a
CSP-blocked frame still fires `onload`, so verify the change by loading the
page, not by trusting the handler.

### What this does not change

The rule in [`classify-platform-url.ts`](../src/lib/classify-platform-url.ts)
that drops `youtube.com` from HÖR-sourced socials stays exactly as it is. Those
are set videos, not evidence of an artist-run channel, and the comment there
already says so. This proposal gives them their own home; it does not promote
them into `artist_links`.

---

## Open questions to evaluate

1. **Is the YouTube API key worth adding?** Layer 2 works without one by
   scraping `ytInitialPlayerResponse`, but that is an undocumented interface on
   a page YouTube rewrites freely. The documented alternative costs a key and
   ~190 quota units for the entire archive.
2. **Where in the page does the embed sit?** Above the Bandcamp player, below
   it, or in the sidebar? Four media blocks on one artist page is the real
   design question this proposal raises, and it is not answered here.
3. **Should an artist with a HÖR binding but no healthy video show anything?**
   The plan says no — render nothing. A "listen on HÖR" text link is the
   alternative, and the HÖR profile link is already in the links list anyway.
4. **Is `hqdefault` sharp enough?** 480×360 in a card that may render wider.
   The alternative is storing which renditions exist per video, which costs one
   extra HEAD per set at harvest and removes the guess permanently.
5. **How common are video-less sets across the whole archive?** Two causes are
   confirmed — `youtube_id = 0` and the `302 → /404/` dead page — but only in a
   six-artist sample. The number decides whether the fallback chain needs one
   spare set per artist or several.
6. **Do the show cards ever omit a set that does have a usable video?** Not in
   the six artists checked, but that is the one assumption the whole
   artist-page-first pipeline rests on. Step 3's reconciliation makes it
   auditable; it does not make it true.
