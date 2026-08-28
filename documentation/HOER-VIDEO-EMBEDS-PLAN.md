# HÖR video embeds — implementation plan

How to put one YouTube-embedded HÖR set on each artist page. The *why* lives in
[PROPOSAL-hoer-video-embeds.md](PROPOSAL-hoer-video-embeds.md), which records
the measurements this plan depends on; this document is the build order and
does not restate them.

**Scope.** One embed per artist page — the artist's most recent HÖR set that
actually has a working video. Not a grid, not a playlist, not a channel feed.

---

## The five invariants

Everything below follows from these. They are the findings that cost the most
to rediscover, so they are stated once, here, as rules.

1. **Never frame hoer.live.** It sends `X-Frame-Options: SAMEORIGIN`. YouTube
   is the only route.
2. **Never read `videoId:` from an artist page.** That belongs to the
   site-wide "Now Playing" sticky player and is a different artist's set. The
   artist's own sets are the `show-card` blocks under `#artist-shows`.
3. **Always request `hqdefault.jpg`.** `maxresdefault.jpg` 404s on ~9% of the
   archive; that is exactly what makes HÖR's own cards look broken.
4. **A set is not a video.** A set can have `youtube_id = 0`, a page that
   `302`s to `/404/`, or a video that later dies. Any of these can hit an
   artist's *newest* set, so the fallback to the next-newest is required, not
   optional.
5. **`hoer_sets` is the authority on whose set it is.** HÖR's markup tells us
   `post_id → video_id`; our own `term_ids` tell us who played. Never infer
   attribution from the page.

---

## Step 1 — Migration

Two files, both applied by hand in the Supabase SQL editor per
[CLAUDE.md](../CLAUDE.md).

### 1a. `migrations/supabase_migration_hoer_set_videos.sql`

Extends the internal ledger. No grants change — `hoer_sets` stays
service-role-only.

```sql
ALTER TABLE "public"."hoer_sets"
  ADD COLUMN IF NOT EXISTS "youtube_video_id" "text",
  ADD COLUMN IF NOT EXISTS "video_status"     "text",
  ADD COLUMN IF NOT EXISTS "video_checked_at" timestamp with time zone;

ALTER TABLE "public"."hoer_sets"
  DROP CONSTRAINT IF EXISTS "hoer_sets_video_status_check";
ALTER TABLE "public"."hoer_sets"
  ADD CONSTRAINT "hoer_sets_video_status_check"
  CHECK ("video_status" IS NULL OR "video_status" IN
    ('ok', 'none', 'removed', 'private', 'not_embeddable', 'unknown'));

-- An ok row must carry an id; a none row must not.
ALTER TABLE "public"."hoer_sets"
  DROP CONSTRAINT IF EXISTS "hoer_sets_video_consistency";
ALTER TABLE "public"."hoer_sets"
  ADD CONSTRAINT "hoer_sets_video_consistency"
  CHECK (("video_status" = 'ok'   AND "youtube_video_id" IS NOT NULL)
      OR ("video_status" = 'none' AND "youtube_video_id" IS NULL)
      OR ("video_status" NOT IN ('ok', 'none'))
      OR ("video_status" IS NULL));

-- The harvester's work queue.
CREATE INDEX IF NOT EXISTS "idx_hoer_sets_video_unchecked"
    ON "public"."hoer_sets" USING "btree" ("post_id")
    WHERE "video_checked_at" IS NULL;
```

`none` is a **converged** state — same discipline as `hoer_terms.scraped_at`.
It means "checked, and there is no video". It must never be retried on the
next run, or every dead 2023 set is re-fetched forever.

### 1b. `migrations/supabase_migration_artist_hoer_sets.sql`

The public projection. `hoer_sets` and `hoer_terms` have RLS on with no anon
policy, so the site cannot read them; this table is what it reads instead.

```sql
CREATE TABLE IF NOT EXISTS "public"."artist_hoer_sets" (
    "artist_id"    "uuid"   NOT NULL
                   REFERENCES "public"."artists"("id") ON DELETE CASCADE,
    "post_id"      bigint   NOT NULL,
    "video_id"     "text"   NOT NULL,
    "title"        "text",
    "set_url"      "text",
    "published_at" timestamp with time zone NOT NULL,
    "updated_at"   timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "artist_hoer_sets_pkey" PRIMARY KEY ("artist_id", "post_id")
);

-- The only query the site runs: newest set for one artist.
CREATE INDEX IF NOT EXISTS "idx_artist_hoer_sets_artist_published"
    ON "public"."artist_hoer_sets" ("artist_id", "published_at" DESC);

ALTER TABLE "public"."artist_hoer_sets" OWNER TO "postgres";
ALTER TABLE "public"."artist_hoer_sets" ENABLE ROW LEVEL SECURITY;

-- Verbatim mirror of the artist_genres / artist_type_assignments policy:
-- rows are public only for approved artists.
DROP POLICY IF EXISTS "Public can view HÖR sets of approved artists"
    ON "public"."artist_hoer_sets";
CREATE POLICY "Public can view HÖR sets of approved artists"
    ON "public"."artist_hoer_sets"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."artists" a
            WHERE a.id = "artist_hoer_sets"."artist_id"
              AND a.directory_status = 'approved'::"public"."artist_status"
        )
    );

GRANT SELECT ON TABLE "public"."artist_hoer_sets" TO "anon";
GRANT SELECT ON TABLE "public"."artist_hoer_sets" TO "authenticated";
GRANT ALL    ON TABLE "public"."artist_hoer_sets" TO "service_role";
```

The composite PK on `(artist_id, post_id)` is what makes b2b sets work: one
video legitimately belongs to two artists, and both get a row.

After applying, add `artist_hoer_sets` to the inventory comment in
`supabase_check_public_role_exposure.sql` and re-run it — that check is the
standing guard that a new public table did not arrive with the wrong grants.

---

## Step 2 — Parse the show cards

`scripts/lib/hoer-page.mjs` already parses `/artist/<slug>/` for the portrait
and socials. Add a third extractor to the same pure, DB-free module so it stays
unit-testable.

```js
/** Show cards under #artist-shows: the artist's OWN sets.
 *  Returns [{ postId, videoId, setUrl }].
 *
 *  NOT to be confused with the `videoId:` in the page's inline script, which
 *  belongs to the site-wide "Now Playing" sticky player and is somebody
 *  else's set entirely. See PROPOSAL-hoer-video-embeds.md, finding 2. */
export function parseShowCards(html) {
  const start = html.indexOf('id="artist-shows"');
  if (start === -1) return [];
  const block = html.slice(start);

  const re = /data-show-id="(\d+)"[\s\S]{0,800}?i\d?\.ytimg\.com\/vi\/([\w-]{11})\//g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(block)) !== null) {
    const postId = Number(m[1]);
    if (seen.has(postId)) continue;
    seen.add(postId);
    out.push({ postId, videoId: m[2] });
  }
  return out;
}
```

**The known weakness, and why it does not matter.** Slicing from
`id="artist-shows"` to the end of the document can over-read into the
site-wide rails further down the page, which contain `show-card` markup of
their own. Rather than tighten the slice with a fragile closing-tag match,
**step 3 discards any `postId` that `hoer_sets.term_ids` does not attribute to
this term** (invariant 5). Over-reading is therefore harmless by construction,
and attribution never depends on getting the HTML boundaries exactly right.

### Tests — `scripts/lib/hoer-page.test.mjs`

Add fixtures for:

- a page with one card → one `{postId, videoId}` pair;
- a page whose sticky-player `videoId:` differs from every card's — assert the
  sticky id is **absent** from the result (this is the regression test for the
  mistake that produced two drafts of the proposal);
- a page with no `#artist-shows` block → `[]`;
- a card list followed by site-wide rails → extra pairs are tolerated (they are
  filtered downstream, so the test asserts the artist's own cards are all
  present, not that nothing else is).

---

## Step 3 — Harvest

New script `scripts/harvest-hoer-videos.mjs`, registered as
`"harvest-hoer-videos": "tsx scripts/harvest-hoer-videos.mjs"` in
`package.json`. House flags: `--limit=N`, `--force`, `--approved`,
`DRY_RUN=1`, matching `enrich-hoer-terms.mjs`.

It must import `./lib/http-dispatcher.mjs` **first** and fetch through
`hoerFetch` from `./lib/hoer-http.mjs`, like every other HÖR crawler.

Per term with a non-null `artist_id`:

1. `GET /artist/<slug>/` → `parseShowCards(html)`.
2. Load that term's sets from `hoer_sets` (`term_ids @> [term_id]`).
3. **Reconcile.**
   - Card `postId` present in the term's sets → candidate
     `{post_id, video_id}`.
   - Card `postId` absent from the term's sets → **discard** (rail bleed).
   - Set with no matching card → `video_status = 'none'`, `video_checked_at =
     now()`. Converged; no retry.
4. **Validate** each candidate (step 4).
5. Write `youtube_video_id` / `video_status` / `video_checked_at` to
   `hoer_sets`, then project (step 5).

A term whose page 404s converges the same way `enrich-hoer-terms.mjs` does:
stamp the check, do not retry forever. A transient failure leaves
`video_checked_at` null so the next run picks it up.

### Fold into Phase C instead?

`enrich-hoer-terms.mjs` already fetches this exact URL, so parsing cards there
costs **zero** extra requests, and that is the end state worth having. Build it
standalone first anyway: Phase C only visits terms where `scraped_at IS NULL`,
so it will not revisit the terms already bound. Ship the standalone script to
backfill the existing corpus, then add `parseShowCards` to Phase C so newly
discovered terms get their videos for free on first scrape.

---

## Step 4 — Validate

Layered, cheapest first. Layer 0 is not a check at all — it is a URL choice,
and it is the one that prevents the failure this whole plan was written around.

| Layer | What | Outcome |
|---|---|---|
| 0 | Build thumbnails as `hqdefault.jpg`, never `maxresdefault.jpg` | invariant 3 |
| 1 | `GET /oembed?url=…&format=json` | `200` → continue · `401` → `private` · `404` → `removed` |
| 2 | `videos.list?part=status,contentDetails` (YouTube Data API) | `not embeddable` / `private` / `removed` → excluded |
| 3 | Render-time fallback | newest **healthy** set, else render nothing |
| 4 | Scheduled revalidation | demote rows that rot |

**Layer 2 uses the YouTube Data API.** *(Decided — was the plan's open
question 1.)* A `200` from oEmbed does **not** mean the video can be embedded:
uploaders can disable third-party playback, and region locks never surface in
oEmbed at all. Scraping `playableInEmbed` out of the watch page's
`ytInitialPlayerResponse` works today but is an undocumented blob on a page
YouTube rewrites freely, so it is rejected.

`YOUTUBE_API_KEY` is documented in `.env.local.example`; add the value to
`.env.local` before running the harvester. It is a free, read-only key — no
billing account, no OAuth.

```js
// 50 ids per call, 1 quota unit per call.
const url = new URL("https://www.googleapis.com/youtube/v3/videos");
url.searchParams.set("part", "status,contentDetails");
url.searchParams.set("id", batch.join(","));   // <= 50
url.searchParams.set("key", process.env.YOUTUBE_API_KEY);
```

Map the response to `video_status`:

| Condition | `video_status` |
|---|---|
| id absent from `items[]` | `removed` |
| `status.privacyStatus !== "public"` | `private` |
| `status.embeddable === false` | `not_embeddable` |
| `contentDetails.regionRestriction.blocked` includes a core market | `not_embeddable` |
| otherwise | `ok` |

An id missing from `items[]` is how the API reports a deleted video — it
returns `200` with a short array, **not** an error, so a naive
`items[i]` zip against the request order will mis-attribute every status after
the first gap. Match on `items[].id`, never on position.

Quota is not a constraint: the whole archive is ~190 units against
10,000/day. If a call ever returns `403 quotaExceeded`, leave
`video_checked_at` null and let the next run retry — do not write `unknown`,
which would converge a set that was never actually checked.

The key is required for the harvester and for step 8. It is **not** needed at
render time; no browser code ever sees it.

---

## Step 5 — Project to the public table

Same script, after validation. Idempotent, and the deletion half matters as
much as the upsert:

```js
// Upsert every ok set for this artist.
await supabase.from("artist_hoer_sets").upsert(rows, { onConflict: "artist_id,post_id" });

// Withdraw anything that is no longer ok — this is how a rotted video
// disappears from the site without a manual step.
await supabase.from("artist_hoer_sets")
  .delete().eq("artist_id", artistId).in("post_id", noLongerOk);
```

`published_at` comes from `hoer_sets.post_date_gmt`, which is stored without a
zone by WP convention — append `Z` when converting, do not let the driver guess.

---

## Step 6 — Read path

### `src/lib/types.ts`

```ts
export interface ArtistHoerSet {
  artist_id: string;
  post_id: number;
  video_id: string;
  title: string | null;
  set_url: string | null;
  published_at: string;
}
```

Add `hoer_sets?: ArtistHoerSet[]` to `ArtistWithRelations`.

### `src/lib/queries.ts`

Add to **`ARTIST_SELECT` only**:

```
hoer_sets:artist_hoer_sets(*)
```

**Not** to `CARD_SELECT`. That select carries a comment explaining it
deliberately omits heavy relations the grid never renders; a video the card
does not show belongs in the same category.

Pick the newest in `normalizeArtist()` rather than in the component, so the
page receives one set or none:

```ts
const hoerSet =
  [...(row.hoer_sets ?? [])]
    .sort((a, b) => b.published_at.localeCompare(a.published_at))[0] ?? null;
```

---

## Step 7 — The component

`src/components/HoerSetWidget.tsx`, a client component (it holds one piece of
state), rendered in the media stack in
[`page.tsx`](../src/app/artist/[id]/page.tsx) **directly after
`<BandcampWidget>`** — the last of the media blocks, before the
booking/management block.

```tsx
"use client";

import { useState } from "react";

interface Props {
  videoId: string;
  title: string | null;
  setUrl: string | null;
  artistName: string;
}

export default function HoerSetWidget({ videoId, title, setUrl, artistName }: Props) {
  const [playing, setPlaying] = useState(false);

  return (
    <div className="mt-6">
      <h2 className="mb-2 text-lg font-semibold">
        On HÖR
        {title && <span className="ml-2 text-sm font-normal text-gray-400">— {title}</span>}
      </h2>

      {playing ? (
        <iframe
          title={`${title ?? artistName} on HÖR`}
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
          width="100%"
          height="315"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
          allowFullScreen
          style={{ border: 0 }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play ${title ?? `${artistName}'s HÖR set`}`}
          className="relative block w-full"
        >
          {/* hqdefault, NEVER maxresdefault — see invariant 3. */}
          <img
            src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
            alt=""
            loading="lazy"
            className="w-full"
          />
          {/* play glyph overlay */}
        </button>
      )}
    </div>
  );
}
```

Why a facade and not a live iframe: a YouTube frame is over a megabyte and runs
third-party script before anyone presses play, on a page that may already be
running a Bandcamp player and up to three SoundCloud widgets.

`setUrl` is not used by the markup above; keep it in the props and link the
heading to the HÖR set page if that reads better in review.

### CSP — `src/proxy.ts`

Add one host to `frame-src`:

```
frame-src https://challenges.cloudflare.com https://bandcamp.com https://w.soundcloud.com https://www.youtube-nocookie.com
```

`img-src` is already `'self' data: blob: https:`, so the thumbnail needs
nothing. Per [SECURITY-HEADERS.md](SECURITY-HEADERS.md), **a CSP-blocked frame
still fires `onload`** — verify by loading the page and watching for a console
violation, not by trusting a handler.

---

## Step 8 — Revalidation

Only the **displayed** video needs re-checking: one per artist with a HÖR
binding. Batched 50-at-a-time through the API that is one or two calls for the
whole directory.

Run `npm run harvest-hoer-videos -- --revalidate` monthly, or fold it into the
existing HÖR sync. A video that turns unhealthy is deleted from
`artist_hoer_sets` and step 6's ordering promotes the next one with no further
action.

---

## Verification

Before merging:

- [ ] `parseShowCards` never returns the sticky-player id (unit test).
- [ ] Every projected `video_id` resolves: `hqdefault.jpg` → 200.
- [ ] Spot-check an artist whose newest set has **no** video (post `70709`,
      Marie Lung) — the page must show the next-newest, not nothing.
- [ ] Spot-check Regina Leather — she is the case that started this; her page
      must show a working embed where HÖR's own card is broken.
- [ ] An artist with no HÖR binding renders exactly as before.
- [ ] A non-approved artist's row is invisible to the anon client (RLS).
- [ ] `supabase_check_public_role_exposure.sql` passes with the new table.
- [ ] Console shows no CSP violation on an artist page with an embed.

---

## Not in scope

- More than one video per artist page.
- Backfilling video IDs for unbound terms — no artist page renders them, so
  the crawl would be wasted.
- Promoting HÖR set videos into `artist_links`. The skip rule in
  [`classify-platform-url.ts`](../src/lib/classify-platform-url.ts) stays as
  it is: a set video is not evidence of an artist-run channel.
- Anything sourced from the HÖR YouTube channel feed directly. Title matching
  is fuzzier than `post_id → video_id` and buys nothing this plan needs.

---

## Open decisions

*(Question 1, whether to use the YouTube Data API, is settled — yes. See
step 4.)*

1. **Placement.** This plan puts the embed last in the media stack. Four media
   blocks on one artist page is a real design question, and reordering is a
   one-line change if review disagrees.
2. **`hqdefault` sharpness.** 480×360 upscaled into a full-width card. If it
   reads soft, probe `maxresdefault` at harvest and store which renditions
   exist, rather than guessing at render time. Cheap once the API key is in
   place: `videos.list` already returns `snippet.thumbnails`, listing exactly
   which renditions exist, so this can be answered from the same call layer 2
   makes rather than by extra HEAD requests.
