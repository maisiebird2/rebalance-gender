# Rebrand plan — Rebalance Gender → All Frequencies (v2)

> **Status: current plan, 2026-09-03.** Supersedes
> [REBRAND-ALL-FREQUENCIES-v1.md](REBRAND-ALL-FREQUENCIES-v1.md). Nothing
> has been executed yet. v1 was checked against the codebase line by line;
> this version corrects what it got wrong and adds what it missed.

Moving the site from **Rebalance Gender** at `rebalance-gender.app` to
**All Frequencies** at `allfrequencies.app`: the name, the logo, the domain,
the GitHub repo, and every piece of external configuration that names one of
them.

The requested scope is five pieces of work — take the site offline, rename it
throughout, rename and privatise the repo, register the domain, relaunch —
and they are §2–§6 below. §1 is the decisions to settle first; §7–§9 are the
steps that surround them: the external services that hold the old name
(Supabase, Resend, Cloudflare Turnstile, Porkbun DNS), the post-launch
verification, and what happens to the old domain.

**Register `allfrequencies.app` before taking the site down** (§5 before
§2). Registration is the only step that can fail outright, and the DNS and
email-domain verification that follow it have lead times measured in hours.
Done first, the site is dark for an afternoon rather than a weekend.

## What changed from v1

- **The holding page is a switch, not a deployment** (§2). v1 promoted a
  separate holding-page deployment, which killed the `/verify` route — so
  every confirmation email already in flight would have failed for the
  whole window — and would have been silently undone the moment the rename
  branch merged, because a push to `main` creates a new production
  deployment. v2 puts the holding page behind an env flag in `src/proxy.ts`,
  exempts the routes that must keep working, and serves it as a **503** so
  search engines keep the existing index.
- **Files v1 missed**: three more user agents
  (`scripts/enrich-bios.mjs`, `scripts/lib/hoer-http.mjs`,
  `scripts/resolve-and-load-links-mb-sp.mjs`); the third CSV column header
  (`scripts/sync-soundcloud.mjs`); `.env.local.example`; the About seed in
  `migrations/supabase_migration_site_content.sql`; `package-lock.json`;
  `scripts/find-duplicates.mjs`; and four docs (`PIPELINE.md`, `GROUPS.md`,
  `URL-RESOLUTION-PLAN.md`, `documentation/README.md`). See §3.5–§3.8.
- **Do it once**: the site-URL fallback (twelve copies) and the user-agent
  string (thirteen copies) each move into one shared module, alongside v1's
  title template. The next rename is then three lines, not ninety files.
  Names that will be needed again are made brand-neutral where they can be
  (§1.7, §3.6).
- **Counts corrected**: seven per-page titles, not nine; nine scripts with a
  hard-coded domain, not ten.
- **The verification grep is now pass/fail** (§3.9): an explicit list of the
  hits that are *supposed* to remain, so anything else is a miss. The last
  rename left `src/lib/email.ts`, `documentation/CONTEXT.md` and
  `scripts/enrich-musicbrainz.mjs` behind precisely because there was no
  such list.
- **Open branches first** (§3.0): four worktrees are active and the rename
  touches most of the files they are likely to touch. Merge or rebase before,
  not after.
- **A pre-cutover snapshot** (§11) so every rollback row has something to
  roll back *to*.
- **Small additions**: Supabase email template subjects (§7.1), a display
  name on the sender (§7.2), the two other Turnstile forms (§7.3, §8), the
  Vercel and Supabase project names and the GitHub description field
  (§4, §6), the `www` → apex check and the width of "Frequencies" on the
  social card (§3.3, §8).

---

## 1. Decisions to settle before any work starts

| # | Decision | Notes / recommendation |
|---|---|---|
| 1.1 | Is `allfrequencies.app` actually available? | Check at Porkbun before anything else. Have a second choice ready (`allfrequencies.fm`, `allfrequencies.co`, `all-frequencies.app`). |
| 1.2 | Canonical host: apex or `www`? | **Recommendation: apex `https://allfrequencies.app`**, with `www` 308-redirecting to it. Today the two are inconsistent — the docs, the scripts and the Supabase Auth Site URL assume `https://www.rebalance-gender.app` while the app code falls back to the bare `https://rebalance-gender.app` (`src/app/layout.tsx:31`). Pick one now; §3.6 makes every fallback the same string. |
| 1.3 | Does the strapline change? | The name currently carries the mission; "All Frequencies" doesn't. The description — "A directory of women and gender-expansive producers and DJs in electronic music" (`src/app/layout.tsx:33`) — now does all that work alone, in the tab title's shadow, on the social card and in search results. Keep it verbatim, and expect it to matter more than it did. |
| 1.4 | What is the new logo? | Two marks exist today and they don't match: the header lockup is two mixing-desk faders that slide level on hover — a literal "rebalance" (`src/app/layout.tsx:99–154`, `src/app/globals.css:253–268`) — while the favicon and Apple icon are a white wave on a violet→magenta gradient (`src/app/icon.svg`, `src/app/apple-icon.tsx`). The fader metaphor dies with the old name. "All Frequencies" points at a spectrum: an EQ curve, a full band of bars, the existing wave. There is already a small equaliser motif (`.eq-mini`, `src/app/globals.css:270–286`) that could grow into the mark. **Recommendation: one mark, used everywhere** — header, favicon, Apple icon, OG card. Keep the violet→magenta gradient (`#6a4dff` → `#ff2d9b`); it is the visual signature and survives the rename intact. |
| 1.5 | What happens to `rebalance-gender.app`? | **Recommendation: keep it registered for at least 12 months** and redirect every path to the new domain (§9). Inbound links, anything indexed, and — in the first 48 hours — live email verification links all point at it. |
| 1.6 | Does the local checkout get renamed too? | **Recommendation: no, not as part of this.** See §10 — it breaks more than it tidies. |
| 1.7 | The identifiers that carry the name | Settle these once so the code rename is mechanical: the npm package name (`all-frequencies`); the GitHub slug (`allfrequencies`); the scraper user-agent token (`AllFrequenciesBot/1.0`) and the API one (`AllFrequencies/1.0 (+https://allfrequencies.app; maisiemeson@gmail.com)` — MusicBrainz asks for a contact); the review-sheet column currently called `rebalance_gender_url`, which should become brand-neutral (`artist_page_url`) so it never needs renaming again. `REBALANCE_OUTPUT_DIR` and the git-hook state file `rebalance-last-stash-count` are **not** renamed — they are private identifiers, and changing the env var would silently break any shell that sets it. |

---

## 2. Take the current site offline

Serve a holding page rather than letting the domain go dark. A dead domain
looks broken; a holding page says the name changed and where it went.

### 2.1 Build it as a switch

1. Add a `src/app/holding/page.tsx` — a single card: new name, one line of
   explanation, "back shortly". No data fetching, so it cannot fail.
2. In `src/proxy.ts`, at the top of `proxy()`, when `HOLDING_PAGE=1` rewrite
   every request that is not exempt to `/holding`, with status **503** and a
   `Retry-After` header. Keep the CSP/nonce logic that follows — the
   holding page is a normal route and still needs the header.

   ```ts
   const EXEMPT = /^\/(holding|verify|api\/|login|reset-password|admin(\/|$)|artist\/[^/]+\/(edit|revise)(\/|$))/;
   if (process.env.HOLDING_PAGE === "1" && !EXEMPT.test(request.nextUrl.pathname)) {
     const url = request.nextUrl.clone();
     url.pathname = "/holding";
     return NextResponse.rewrite(url, { status: 503, headers: { "Retry-After": "3600" } });
   }
   ```

   Exempt: `/verify` and `/api/*`, so the confirmation links in emails
   already sent keep working; `/login`, `/reset-password`, `/admin/*` and
   the edit/revise routes, so moderation carries on. Serving **503** rather
   than 200 matters: search engines treat it as temporary and leave the
   existing index alone, whereas a 200 holding page gets indexed as the new
   homepage.
3. Ship this as its own small PR **before** the rename. It is inert until the
   flag is set, and it is the tool to reach for in any future maintenance
   window.

### 2.2 Flip it

- **To go dark:** Vercel → Settings → Environment Variables → add
  `HOLDING_PAGE=1` for Production, then **Redeploy** the current deployment
  (env changes never apply to a running deployment).
- **To come back:** remove the variable and redeploy again (§6.6).

Same deployment both times; nothing to promote, and a merge to `main` during
the window cannot lift the holding page by accident — it would have with a
promoted deployment, because every push to `main` creates a new production
deployment.

The blunter alternative still exists: Vercel → Settings → **Deployment
Protection** → password-protect production. Faster, but visitors get an auth
prompt, which reads as broken, and it blocks `/verify` too.

### 2.3 Worth knowing while it is down

- **Public submissions stop** — `/submit`, `/artist/<id>/revise` and the
  search-miss suggestion are behind the rewrite. Confirmations of
  already-sent emails, the moderation queue and the admin panel are not.
- **The data pipeline is unaffected.** Every script in `scripts/` talks to
  Supabase directly, not through the site.
- **Nothing needs to change in Supabase yet.** The database is untouched by
  the rebrand except for the About text (§3.4).

---

## 3. Rename the site in code

### 3.0 Clear the decks first

The rename touches about ninety files, including `layout.tsx`, `globals.css`
and every sync script. Four worktrees are open right now
(`artist-releases-plan`, `recommended-artists-sidebar`,
`resolve-links-approved-only`, `soft-delete-single-link-dupes`). Any of them
that touches those files will conflict on merge. Merge what is ready before
the rename lands; rebase the rest onto `main` straight after. Do the rename
itself in its own worktree (`scripts/new-worktree.sh rebrand-code`).

### 3.1 Central strings and the header lockup

| File | What |
|---|---|
| `src/app/layout.tsx:31` | `SITE_URL` fallback — replaced by the shared module in §3.6 |
| `src/app/layout.tsx:38–50` | `metadata.title`, `openGraph.siteName`, `openGraph.title`, `twitter.title` |
| `src/app/layout.tsx:96` | `aria-label="Rebalance Gender — home"` |
| `src/app/layout.tsx:99–154` | The inline fader SVG — replaced by the new mark (1.4) |
| `src/app/layout.tsx:155–158` | The stacked wordmark: `<span>Rebalance</span>` / `<span className="grad-text">Gender</span>`. "All Frequencies" splits the same way — plain "All", gradient "Frequencies" — so the two-line lockup and its type scale survive. At 19px "Frequencies" fits the header; see §3.3 for the 128px version |
| `src/app/globals.css:253–268` | The `.fader-mark` hover animation and its comment ("a literal *rebalance*") — replaced or removed with the mark |
| `src/app/globals.css:288–302` | The `prefers-reduced-motion` block that disables that animation — update in step with it |

### 3.2 Per-page browser-tab titles

Seven files set a title containing the site name:

`src/app/about/page.tsx:5`, `src/app/submit/page.tsx:11`,
`src/app/artist/[id]/page.tsx:31`, `src/app/artist/[id]/edit/page.tsx:43`,
`src/app/artist/[id]/revise/page.tsx:22`,
`src/app/organisation/[id]/page.tsx:33`,
`src/app/admin/organisations/[id]/page.tsx:36`.

**Do this once rather than seven times.** Add a title template to the root
layout —

```ts
title: { default: "All Frequencies", template: "%s | All Frequencies" },
```

— and reduce each page to its own part (`"About"`, `artist.name`). The
suffix then lives in one place. The current suffixes are inconsistent anyway
(`·` on About, `—` on Submit, `|` elsewhere); the template settles that too.

### 3.3 Social card and icons

- `src/app/opengraph-image.tsx` — the `alt` text (lines 7–8), the comment
  above it, the two wordmark spans (line 86 and its "Gender" sibling), and
  the fader shapes that mirror the header lockup. **Check the width:** the
  wordmark is set at 128px and "Frequencies" is nearly twice the length of
  "Gender". It should still fit beside the mark in 1200px, but render it and
  look before merging; drop the size rather than let it wrap.
- `src/app/twitter-image.tsx` — re-exports the OG image, so it follows
  automatically. No edit needed.
- `src/app/icon.svg`, `src/app/apple-icon.tsx` — the new mark (1.4).
- Both image routes are generated at request time by `next/og`, so they
  refresh on deploy. Social platforms cache aggressively: re-scrape the new
  URL in each debugger after launch (§8).

### 3.4 The About page text is **not** in the repo

`src/app/about/page.tsx` renders admin-authored HTML from the Supabase
`site_content` table (key `about`), edited at **/admin/about**. The only
string in the file is the fallback used when that row is missing (line 14).

So: rewrite the About copy in the admin panel, and update the fallback and
the page's own `description` (lines 5–7) in code. Easy to miss, because a
repo-wide find-and-replace reports the file as done.

Two more places carry the same copy:

- `migrations/supabase_migration_site_content.sql:46` seeds the About row
  with "Rebalance Gender is a directory…". It is `on conflict do nothing`,
  so it only ever affects a fresh database — but the checked-in seed should
  not carry the old name, and the grep in §3.9 will find it.
- Anything else in the admin surface that names the site: the homepage stat
  copy driven by `site_stats` (`scripts/update-artist-count.mjs`) and any
  other `site_content` keys.

### 3.5 Outbound identity — user agents

These are how the project introduces itself to other people's servers.
MusicBrainz requires an accurate, contactable user agent and Discogs expects
the same. There are **thirteen** copies today, in four different shapes:

| File | Current value |
|---|---|
| `src/lib/search-providers.ts:36–37` | `RebalanceGenderDirectory/1.0 (<site url>)` |
| `src/lib/scrape-images.ts:255` | `Mozilla/5.0 (compatible; RebalanceGenderBot/1.0; +profile picture enrichment)` |
| `src/lib/resolve-url-redirects.ts:226` | `… RebalanceGenderBot/1.0; +link resolving` |
| `scripts/sync-linktree.mjs:202`, `scripts/sync-bandcamp.mjs:550`, `scripts/lib/hoer-http.mjs:17` | `… RebalanceGenderBot/1.0; +profile enrichment` |
| `scripts/store-images.mjs:259` | `… RebalanceGenderBot/1.0; +profile image storage` |
| `scripts/enrich-bios.mjs:252` | `… RebalanceGenderBot/1.0; +bio enrichment` |
| `scripts/sync-discogs.mjs:243,311`, `scripts/export-discogs-label.mjs:134` | `RebalanceGender/1.0 +https://rebalance-gender.com` — note the **`.com`**, which has never been the site's domain |
| `scripts/resolve-and-load-links-mb-sp.mjs:297` | `RebalanceGender/1.0 (contact via site)` — sent to MusicBrainz with no real contact |
| `scripts/enrich-musicbrainz.mjs:121` | `WomenInElectronicMusicDirectory/1.0 (maisiemeson@gmail.com)` — two names out of date |

**Do this once.** Add `scripts/lib/user-agent.mjs` exporting two strings —
`BOT_UA` for scraping (`Mozilla/5.0 (compatible; AllFrequenciesBot/1.0;
+https://allfrequencies.app)`) and `API_UA` for MusicBrainz and Discogs
(`AllFrequencies/1.0 (+https://allfrequencies.app; maisiemeson@gmail.com)`)
— and a matching `src/lib/user-agent.ts` for the three app-side callers.
The per-purpose suffixes ("+profile enrichment") were never read by anyone;
a URL and a contact address are what the etiquette actually asks for.
`documentation/URL-RESOLUTION-PLAN.md:55` documents the old token — update it.

### 3.6 Hard-coded domain fallbacks

Twelve files default the site URL when `NEXT_PUBLIC_SITE_URL` is unset, in
two different spellings. Nine scripts use `https://www.rebalance-gender.app`
— `sync-linktree.mjs:166`, `sync-bandcamp.mjs:221`, `sync-soundcloud.mjs:301`,
`resolve-link-redirects.mjs:165`, `integrate-harvested-links.mjs:197`,
`export-lastfm-links.mjs:56`, `export-link-backfill-candidates.mjs:93`,
`export-pending-hoer-artists.mjs:80`, `export-hoer-sc-followees.mjs:59` —
and three app files use the bare `https://rebalance-gender.app`:
`src/app/layout.tsx:31`, `src/lib/search-providers.ts:37`,
`src/app/api/admin/reports/harvest-failures/route.ts:11`.

**Do this once.** Add `scripts/lib/site-url.mjs`:

```js
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://allfrequencies.app").replace(/\/+$/, "");
```

and `src/lib/site-url.ts` with the same line, and import them everywhere
above. One string, the canonical host from 1.2, and the `www`/apex
inconsistency goes away with it. Leave `src/lib/email.ts:28` alone — its
fallback is deliberately `http://localhost:3000` so a misconfigured dev box
can never send production links.

Related:

- `scripts/apply-pending-hoer-decisions.mjs:98` parses artist URLs and
  accepts both host forms of the old domain; add the new one.
- The review-sheet column `rebalance_gender_url` appears in **three**
  writers — `sync-bandcamp.mjs:964`, `sync-linktree.mjs:706` and
  `sync-soundcloud.mjs:1212` (plus the comment at `:1185`) — and is
  described in `documentation/PIPELINE.md:368` and, as "Rebalance Gender
  URL", in `documentation/GROUPS.md:68,184`. Rename it to `artist_page_url`
  (1.7). Any half-processed sheet from before the rename will no longer
  match: finish or discard outstanding sheets first.
- `parseArtistIdInput` (`src/lib/duplicate-of.ts`) is host-agnostic, so
  pasted links keep working from either domain. Its fixtures use
  `rebalancegender.com` (`src/lib/duplicate-of.test.ts:21–24,37`) —
  cosmetic, but they are in the grep.

### 3.7 Legacy name still in the emails

`src/lib/email.ts` never got updated from the *previous* rename. Every
verification email says **"the Women in Electronic Music directory"** (lines
54, 55, 76), and the module doc-comment gives
`https://womeninelectronicmusic.com` as the example origin (line 9). Fix all
four.

While there: the `from` header (line 81) is the bare address, so mail
clients show `noreply` as the sender. Send as
`` `All Frequencies <${FROM_ADDRESS}>` `` — Resend accepts the display-name
form, and `RESEND_FROM_ADDRESS` stays a bare address because Supabase SMTP
(§7.2) needs it bare.

The same stale name heads `documentation/CONTEXT.md:1`, whose overview also
claims the site is "live at rebalance-gender.com" (line 12) — wrong TLD.

### 3.8 Repo metadata and documentation

- `package.json:2` — `"name": "rebalance-gender"` → `"all-frequencies"`,
  then `npm install --package-lock-only` so the two `name` fields in
  `package-lock.json` follow. Don't hand-edit the lock file.
- `.env.local.example:30` — the example sender `noreply@rebalance-gender.app`.
- `README.md:1` — title.
- `documentation/CONTEXT.md` — title, the live URL, the registrar/deployment
  section.
- `documentation/OPERATIONS.md` — every `rebalance-gender.app` in the auth
  and SMTP tables (the `/login` URL at line 24, the URL Configuration table,
  the SMTP sender rows). This file is the runbook for §7; update it as those
  steps are done, not before.
- `documentation/PIPELINE.md:368`, `documentation/GROUPS.md:68,184`,
  `documentation/URL-RESOLUTION-PLAN.md:55` — the column name and the user
  agent (§3.5, §3.6).
- `documentation/README.md` — the index row for this plan, once the work is
  done.
- `migrations/supabase_migration_artist_duplicate_of.sql:12` and
  `scripts/find-duplicates.mjs:3` — comments that name the directory.
- **Leave alone**: the "Usage (from the rebalance-gender/ folder)" comments
  across `scripts/` (they describe the local directory, §10), the absolute
  paths in `CLAUDE.md`, `documentation/OUTPUT-FILE-LOCATION.md` and
  `scripts/apply-hoer-decisions-2026-07-26.mjs` (same), and
  `documentation/RECOMMENDED-ARTISTS-SIDEBAR-PATCH.md:14` (a dated record of
  what was sampled on the old domain).

### 3.9 Verify before merging

```bash
npm run lint && npm test && npm run build
```

Then the acceptance grep. The second `grep` removes every hit that is
*supposed* to survive — the env var, the hook state file, the local-folder
comments and paths, this plan and the historical sidebar note. The folder
pattern is deliberately narrow: a looser `Rebalance Gender"` would also hide
`title: "Rebalance Gender",` and its five siblings.

```bash
grep -rniE "rebalance|women ?in ?electronic" src scripts public migrations documentation README.md CLAUDE.md package.json .env.local.example \
  | grep -vE 'REBALANCE_OUTPUT_DIR|rebalance-last-stash-count|Usage \(from|rebalance-gender-repo|Rebalance Gender/|"Rebalance Gender"( folder|$)|REBRAND-ALL-FREQUENCIES|RECOMMENDED-ARTISTS-SIDEBAR'
```

**It must print nothing.** Run today, it lists exactly the 44 files in §3 —
so it is the to-do list before the rename and the acceptance test after it.
Anything it prints later is a miss, not a judgement call.

---

## 4. Rename the GitHub repo and make it private

Currently `https://github.com/maisiebird2/rebalance-gender` (public). No
file in the repo links to that URL other than this plan, so nothing in code
or docs needs to follow.

1. **Rename** — GitHub → repo → Settings → General → Repository name →
   `allfrequencies`. GitHub redirects the old path indefinitely for Git
   operations and for web URLs (including `/compare/…` PR-creation links),
   so nothing breaks immediately, but update the remote anyway:

   ```bash
   git remote set-url origin https://github.com/maisiebird2/allfrequencies.git
   ```

   One `set-url` covers **all five checkouts** — the primary one and the
   worktrees under `.claude/worktrees/` share a single `.git`.

   Update the repo's **description** and **website** fields on the same
   page; they still say the old name and domain.

2. **Make private** — Settings → General → Danger Zone → Change visibility.
   Before clicking:
   - **Vercel keeps deploying.** The GitHub integration is installed on the
     same account, so a private repo deploys exactly as a public one did.
     Confirm the Vercel project still shows a connected Git repository
     immediately afterwards; a rename can leave the connection stale, in
     which case reconnect it under Project → Settings → Git.
   - **No CI to worry about.** There is no `.github/` directory, so no
     Actions minutes become billable.
   - Stars, watchers and forks lose access. Existing forks stay public and
     keep the code as of the fork — going private does not retract what has
     already been published.
   - Anything public that links to the repo becomes a 404 for everyone else.
3. Merge every open PR **before** the visibility change, so nothing is in
   flight while permissions move.

---

## 5. Register `allfrequencies.app` — do this first

Porkbun already holds the current domain, so keep both in one account.

1. Check availability and register. Watch the renewal price, not just the
   first-year price.
2. **`.app` is HSTS-preloaded at the TLD level.** Every browser refuses
   plain HTTP to any `.app` domain, with no clickable warning to bypass —
   the site simply will not load until a valid certificate is live. In
   practice: DNS first, certificate issued by Vercel, *then* test. A "site
   is down" panic ten minutes after the DNS change is usually just the
   certificate still being issued. (The current domain is `.app` too, so
   this is a constraint the project already lives with.)
3. On the new domain immediately: **auto-renew on**, **registrar lock on**,
   **WHOIS privacy on**, and 2FA on the Porkbun account itself.
4. Optional, cheap, decide once: defensive registrations
   (`allfrequencies.com`, `.co`, `.fm`) redirected to the canonical host.
5. Not the domain, but the same job — check whether the matching handles are
   free on the platforms the directory lives alongside (Instagram,
   SoundCloud, Bluesky) and claim them while the name is new.

---

## 6. Bring the site up on the new domain

1. **Vercel → Project → Settings → Domains** → add `allfrequencies.app` and
   `www.allfrequencies.app`. Set the non-canonical one to redirect to the
   canonical one (1.2).
2. **Porkbun DNS** — add exactly the records Vercel shows (an `A` or `ALIAS`
   record at the apex, `CNAME` for `www`). Lower the TTL on the *old*
   domain's records a day beforehand if a fast rollback matters.
3. Wait for Vercel to report the certificate as issued. Only then test — see
   the `.app` HSTS note in §5.
4. **Environment variables** — Vercel → Settings → Environment Variables:
   set `NEXT_PUBLIC_SITE_URL=https://allfrequencies.app` for Production
   (and Preview, if it is set there). Update `RESEND_FROM_ADDRESS` after
   §7.2. `NEXT_PUBLIC_*` values are inlined at build time, so an env change
   without a rebuild changes nothing — the merge in the next step is the
   rebuild.
5. Merge the rename branch. The Git integration deploys it to production;
   with `HOLDING_PAGE=1` still set, visitors keep seeing the holding page
   while you finish §7. Update the local `.env.local` to match — the
   worktrees symlink it, so one edit covers them all.
6. **Go live:** remove `HOLDING_PAGE` and redeploy (§2.2).
7. Optional: rename the Vercel project to match. It changes the project's
   `*.vercel.app` preview domain, so any bookmarked deployment URLs die —
   cosmetic otherwise. The Supabase project name (Project Settings →
   General) is the same kind of thing.

**Nothing to change in the CSP.** `src/proxy.ts` builds the policy from
`'self'` plus the Supabase URL, Cloudflare Turnstile, Bandcamp and
SoundCloud — no site domain is named, so the header follows the move for
free. Same for `next.config.mjs` `images.remotePatterns` (third-party image
hosts only) and every Supabase Storage image URL (served from the Supabase
domain). There are no cookies, storage keys or bucket names that carry the
brand either.

---

## 7. External services that hold the old name

The step most likely to be forgotten, because none of it lives in the repo.
`documentation/OPERATIONS.md` is the existing runbook for 7.1–7.2.

### 7.1 Supabase Auth

Authentication → **URL Configuration**:

| Setting | New value |
|---|---|
| Site URL | `https://allfrequencies.app` (today it is the `www.` form of the old domain — align with 1.2) |
| Redirect URLs | add `https://allfrequencies.app/reset-password` (keep `http://localhost:3000/**`; keep the old domain's entry until the redirect period ends) |

Leave the Reset Password template's `{{ .SiteURL }}` alone — it picks up
the new Site URL automatically. If Site URL is not changed, password
recovery links keep pointing at the old domain and appear to do nothing.

Then **Authentication → Emails**: open each enabled template (Reset Password
is the only one the app uses; there is no sign-up flow) and check its
**subject line** and body for the old name. Template copy is not in the
repo and the grep cannot see it.

### 7.2 Resend (transactional and auth email)

1. Resend → Domains → add `allfrequencies.app` and add the DKIM/SPF (and
   DMARC, if used) records it gives you to Porkbun DNS. Verification is the
   slowest part of the whole move — start it the day the domain is
   registered.
2. Once verified, set `RESEND_FROM_ADDRESS=noreply@allfrequencies.app` in
   Vercel and `.env.local`. Keep it a bare address; the display name is
   added in code (§3.7).
3. Supabase → Authentication → Emails → **SMTP Settings**: update the sender
   email to the same address and the sender name to `All Frequencies`.
   Host/username/password are unchanged.
4. Keep the old Resend domain verified until the redirect period ends —
   there is no reason to break replies to already-sent mail.
5. A brand-new sending domain has no reputation. Expect the first messages to
   land in spam more often; send a few to your own addresses across providers
   before relying on it.

### 7.3 Cloudflare Turnstile

Turnstile widgets are bound to hostnames. Add `allfrequencies.app` (and
`www.`) to the existing widget's hostname list, keeping the old domain until
the redirect period ends — that reuses the current keys and needs no env
change. If a new widget is created instead, both
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` must be updated
in Vercel together.

**Test all three Turnstile forms end to end after this** — submit
(`SubmissionForm`), revise (`RevisionForm`) and the search-miss suggestion
(`SearchMissResults`). A Turnstile misconfiguration fails *silently*: the
widget renders, the visitor submits, and verification rejects the token
server-side. This project has been bitten by exactly that before.

### 7.4 Search

- No `robots.txt` or `sitemap.xml` exists today. Adding a sitemap as part of
  the relaunch is the cheapest thing that helps the new domain get indexed —
  the artist and organisation routes are enumerable from Supabase.
- Google Search Console: add `allfrequencies.app` as a property. If the old
  domain was verified there, use **Change of Address** to pass the move on
  explicitly; it depends on the 308 redirects in §9 being in place.

---

## 8. Post-launch verification

Run against the new domain, signed out and then signed in:

- [ ] `curl -sI https://allfrequencies.app/` returns **200**, not 503, and
      no `Retry-After` — i.e. `HOLDING_PAGE` really is gone
- [ ] `curl -sI https://www.allfrequencies.app/` is a 308 to the apex (1.2)
- [ ] Home page loads, artist count copy is correct, images render
- [ ] An artist page and an organisation page load; SoundCloud/Bandcamp
      embeds play (CSP `frame-src`)
- [ ] About page shows the **rewritten** copy (§3.4), not the fallback
- [ ] Browser tab titles read "All Frequencies" on every route type: home,
      artist, organisation, about, submit, admin
- [ ] Favicon and Apple touch icon are the new mark; hard-refresh, favicons
      cache hard
- [ ] Submit an artist end to end: Turnstile passes → verification email
      arrives from "All Frequencies" at the new address → the link points
      at the new domain → confirming lands the row in the moderation queue
- [ ] Revise an artist and send a search-miss suggestion — the other two
      Turnstile paths (§7.3)
- [ ] Login, sign out, and "Forgot password?" → recovery email → set a new
      password → back to `/login`
- [ ] Admin panel: moderation queue, missing-links, `/admin/about`,
      `/admin/settings`
- [ ] Old-domain redirects: `rebalance-gender.app` → new home, and a deep
      link such as `/artist/<uuid>` → the same path on the new domain
- [ ] Security headers still present (`curl -sI` for `X-Frame-Options`,
      `Content-Security-Policy`) — see `documentation/SECURITY-HEADERS.md`
- [ ] OG card: re-scrape in the social debuggers, confirm the new wordmark
      and that "Frequencies" is not wrapped or clipped (§3.3)
- [ ] A 404 route still renders correctly
- [ ] The pipeline: run one read-only script (`npm run find-duplicates`)
      to confirm the shared site-URL and user-agent modules import cleanly

---

## 9. The old domain

Add `rebalance-gender.app` and `www.rebalance-gender.app` to the *same*
Vercel project and configure them to **redirect to the new domain, preserving
the path** (Vercel's domain redirect does this; 308 keeps method and passes
search-engine signals). Artist and organisation IDs are database UUIDs and
do not change, so every existing deep link survives the move intact.

Keep it registered and redirecting for at least 12 months. Check auto-renew
on it now, while it still matters — an expired redirect domain is how link
rot starts, and a lapsed one can be picked up by anyone.

---

## 10. What *not* to rename

The local checkout is `~/Claude/Projects/Rebalance Gender/rebalance-gender-repo`.
Leave it alone, at least for now:

- The active worktrees are registered by absolute path under
  `.claude/worktrees/`. Renaming a parent directory breaks all of them.
- The output-file convention resolves `<repo>/../output files` through
  `scripts/lib/output-path.mjs` and the mirrored constant in
  `scripts/review_candidates.py`. It follows a rename automatically, but the
  literal path is written into `CLAUDE.md`,
  `documentation/OUTPUT-FILE-LOCATION.md` and
  `.claude/settings.local.json`, which would then be wrong.
- `.env.local` and `node_modules` are symlinked from each worktree into the
  primary checkout.

If the folder name should match the brand, do it as its own task: remove the
worktrees, rename, re-create them, then update the paths in `CLAUDE.md` and
the docs. It has nothing to do with the public rebrand.

The private identifiers from 1.7 (`REBALANCE_OUTPUT_DIR`,
`rebalance-last-stash-count`) stay too.

---

## 11. Snapshot, then rollback

### 11.1 Before the window opens

Every rollback below needs something to roll back *to*. Capture, in one
note or a folder of screenshots:

- Vercel → Environment Variables (Production and Preview), and the URL of
  the current production deployment — it is immutable, so it can be
  re-promoted in one click.
- Porkbun → the old domain's DNS records as they stand.
- Supabase → Authentication → URL Configuration and SMTP Settings.
- The current About HTML, copied out of `/admin/about`.
- Cloudflare → the Turnstile widget's hostname list.

### 11.2 If something goes wrong

Nothing here is one-way until the old domain expires.

| If | Then |
|---|---|
| The rename deploy is broken | Set `HOLDING_PAGE=1` again (§2.2) — visitors see the holding page, not a broken site — then re-promote the snapshotted deployment or fix forward. |
| The new domain misbehaves after cutover | Re-promote the previous production deployment on Vercel and point `rebalance-gender.app` back at it. Both domains sit on the same project, so this is a redirect setting, not a redeploy. |
| Email breaks | The old Resend domain is still verified — revert `RESEND_FROM_ADDRESS` and the Supabase SMTP sender, and redeploy. |
| Submissions start failing silently | Almost certainly Turnstile hostnames (§7.3). |
| The repo rename causes trouble | GitHub redirects the old path indefinitely, and visibility can be flipped back to public at any time. |

Lower the old domain's DNS TTL a day before cutover if a fast rollback
matters.

---

## 12. Suggested running order

| Order | Step | Blocking? |
|---|---|---|
| 1 | Settle §1, especially availability (1.1), the logo (1.4) and the identifiers (1.7) | Yes — everything else assumes them |
| 2 | Register `allfrequencies.app`; lock, privacy, auto-renew (§5) | Yes |
| 3 | Start Resend domain verification (§7.2) — begin the same day, it is the slowest | No, runs in parallel |
| 4 | Merge or rebase the open branches (§3.0) | Yes — before the rename lands |
| 5 | Ship the holding-page switch, inert (§2.1) | No |
| 6 | Do the code rename on a branch; lint, test, build and the §3.9 grep all clean | No |
| 7 | Take the snapshot (§11.1) | — |
| 8 | Set `HOLDING_PAGE=1`, redeploy — the site is now "down" (§2.2) | — |
| 9 | Add the domain in Vercel, DNS at Porkbun, wait for the certificate (§6.1–3) | Yes |
| 10 | Update Vercel env vars; merge the rename branch (§6.4–5) | Yes |
| 11 | Supabase Auth URLs and templates, Resend sender, Turnstile hostnames (§7) | Yes |
| 12 | Rewrite the About copy in `/admin/about` (§3.4) | No |
| 13 | Remove `HOLDING_PAGE`, redeploy — live on the new domain (§6.6) | — |
| 14 | Redirect the old domain (§9) | No |
| 15 | Rename the GitHub repo and make it private (§4) | No — safest once everything is deployed and stable |
| 16 | Verification pass (§8); Search Console (§7.4) | — |

Steps 8–13 are the only window in which the site is unavailable to
visitors — and even then, confirmation links and the admin panel keep
working. Done in one sitting, with the domain already registered and Resend
verification already under way, that window is a couple of hours, most of
it spent waiting for a certificate.
