# Proposal — embed each artist's most recent HÖR set

> **Status: proposal, not accepted.** Written 2026-08-24 from a design
> discussion. Nothing here is built. The findings in
> [What we verified](#what-we-verified) are empirical — they were measured
> against hoer.live and YouTube on the day of writing — and two of them
> (no framing; the artist-page hero is not the artist's video) rule out the
> obvious implementations, so read that section before the plan.

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

Five things were measured rather than assumed. Three of them changed the plan.

### 1. hoer.live cannot be embedded at all

```
$ curl -sI https://hoer.live/trujillo-hor-august-24-2026/
x-frame-options: SAMEORIGIN
```

Every hoer.live page refuses to be framed by a third-party origin. There is no
"embed the HÖR player directly" option, on any page, for anyone. **YouTube is
the only route.** This is not a preference; it is the whole decision.

### 2. The video ID is only in the set page's HTML

The set page carries the ID inline, in the bootstrap for YouTube's IFrame API:

```js
player = new YT.Player('player', { videoId: 'fIHTqo4sMS8', … })
```

Every cheaper source was checked and rejected:

| Source | Result |
|---|---|
| WP REST `meta` | ✗ Exposes only `_acf_changed` and `footnotes`. The real field is the ACF meta key `youtube_id`, which is not registered for REST. |
| WP REST `content.rendered` | ✗ Empty string on every set post sampled. |
| ACF REST (`/wp-json/acf/v3/posts/<id>`) | ✗ `rest_no_route`, 404. |
| Set page HTML | ✓ One regex on `videoId: '…'`. |

So the harvest is **one HTTP GET per set**, matching the existing crawl posture
in [`enrich-hoer-terms.mjs`](../scripts/enrich-hoer-terms.mjs).

That `youtube_id` key is worth noting for a second reason. HÖR's own
load-more endpoint queries posts with `{"key":"youtube_id","compare":"!=","value":"0"}`
— **HÖR itself treats `youtube_id = 0` as "this set has no video"**. Sets
with no video therefore exist by design, and the harvester must tolerate a set
page with no `videoId` rather than treating it as a failure.

### 3. The artist-page hero video is NOT the artist's set

This is the finding that answers "why do some HÖR pages show an embed that
doesn't work", and it invalidates the cheapest-looking implementation.

`/artist/<slug>/` renders a hero player. It is tempting to read the video ID
from there, because [`enrich-hoer-terms.mjs`](../scripts/enrich-hoer-terms.mjs)
already fetches that exact page for the portrait and socials, so the ID would
cost **zero** extra requests.

It is the wrong video. Sampled in one pass:

| Artist page | Their newest set | Hero video actually shown |
|---|---|---|
| `regina-leather` | 2020-07-21 | `aurora-halal-hor-aug-9-2023` |
| `trujillo` | 2026-08-24 | `large-marge-pepiita-hor-november-2-2023` |
| `deepa-biri` | 2020-07-13 | `xhumans-bconscious-hor-august-12-2024` |
| `curses` | 2023-07-26 | `onlytrance-dj-traytex-b2b-antnk-hor-august-13-2024` |
| `dr-rubinstein` | 2022-12-06 | `ali3n-hor-september-9-2024` |
| `machina` | 2023-01-04 | `lux2000-hor-march-7-2025` |
| `marie-lung` | 2024-01-09 | `g1rlontop-hor-july-31-2026` |
| `jammy` | 2025-01-06 | `flirt-records-route-8-hor-october-17-2025` |
| `florian-kupfer` | 2020-03-26 | `dukwa-hor-may-26-2025` |

**9 of 9 heroes belonged to a different artist.** The hero is a rotating
site-wide featured set, re-drawn per request — an earlier fetch of
`trujillo` returned Trujillo's own set purely because it happened to be the
newest set on the site that hour, and a later fetch of the same URL returned a
different artist's. Reading it once and believing it would silently attribute
someone else's set to an artist on our pages.

**Rule: the video ID must come from the set page, keyed on
`hoer_sets.post_id`.** The set→artist mapping is already authoritative in our
own database (`hoer_sets.term_ids` → `hoer_terms.artist_id`), so we never need
HÖR to tell us whose video it is.

### 4. The videos themselves are healthy

32 sets sampled across the full archive, four per year from 2019 to 2026,
resolving each set page's video ID and then probing YouTube:

```
total 32 | no videoId: 0 | oembed != 200: 0 | not embeddable: 0
```

All 32 returned `playabilityStatus.status = "OK"` and
`playableInEmbed = true`. Regina Leather's own 2020 set — the page that
prompted the question — resolves to `SiWwESb_W-o`, which is public, live and
embeddable right now.

**The broken embed on `/artist/regina-leather/` is HÖR's hero bug from finding
3, not a dead video.** Her set is fine; the player on that page was pointed at
someone else's stream. Because we take IDs from set pages, we would not
reproduce that failure.

The remaining thing that page demonstrates is HÖR's own cookie-consent gate,
which blanks their embeds until a visitor consents. That is their
implementation, not a property of the videos, and does not follow the ID to our
site.

### 5. Health can still rot, so it must still be checked

A 0-in-32 failure rate today is not a guarantee for a 9,500-video archive over
time. Videos get deleted, made private, region-locked, or have embedding
switched off — all after we harvested the ID. So the plan below validates
anyway; see [Guarding against dead embeds](#guarding-against-dead-embeds).

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

1. **Select work.** Sets whose `term_ids` intersect a term with a non-null
   `artist_id`, where `video_checked_at IS NULL`, newest first. This is a small
   fraction of the 9,565-row ledger — do **not** crawl the whole archive.
2. **Fetch the set page**, regex `videoId: '([\w-]{11})'`.
3. **Validate** (below), write `youtube_video_id` / `video_status` /
   `video_checked_at`.
4. **Project** `ok` rows into `artist_hoer_sets`; delete rows that stop being
   `ok`.

Steps 3–4 also run standalone as a revalidation pass.

### Bounding the crawl further

Only the newest set per artist is ever displayed, so the harvester can walk
sets newest-first per artist and stop after it has found, say, **three healthy
videos** for that artist — one to show and two in reserve for the fallback
chain. That turns a per-set crawl into an effectively per-artist one.

---

## Guarding against dead embeds

Four layers, cheapest first. The user-visible contract is: **an artist page
shows a working video or shows no video block at all — never a broken player.**

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

The page query asks for the newest **healthy** set. If an artist has none, the
component returns `null` and the page renders exactly as it does today. This
is the same posture the SoundCloud widget already takes when
`track_count === 0` — suppress rather than embed something empty.

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
widgets. Render `https://i.ytimg.com/vi/<id>/hqdefault.jpg` with a play
control, and swap in the iframe on click with `autoplay=1`.

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
4. **How aggressively should the harvest be bounded?** "Three healthy videos
   per artist, newest first" is a guess. One is enough to display; more is
   insurance against rot at the cost of crawl time.
5. **Sets with no video (`youtube_id = 0`).** Confirmed to exist by HÖR's own
   query. Their frequency has not been measured, only that the harvester must
   converge on them rather than retry.
