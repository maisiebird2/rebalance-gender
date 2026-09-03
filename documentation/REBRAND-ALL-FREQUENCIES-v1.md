# Rebrand plan — Rebalance Gender → All Frequencies (v1)

> **Status: superseded by [REBRAND-ALL-FREQUENCIES-v2.md](REBRAND-ALL-FREQUENCIES-v2.md)**
> (2026-09-03). Kept unchanged for the record; nothing below has been
> executed. The v2 header lists what it corrects and adds.

Moving the site from **Rebalance Gender** at `rebalance-gender.app` to
**All Frequencies** at `allfrequencies.app`: the name, the logo, the domain,
the GitHub repo, and every piece of external configuration that names one of
them.

The requested scope is five pieces of work — take the site offline, rename it
throughout, rename and privatise the repo, register the domain, relaunch —
and they are §2–§6 below. §1 is the decisions to settle first, §7–§9 are the
steps that surround them: the external services that hold the old name
(Supabase, Resend, Cloudflare Turnstile, Porkbun DNS), the post-launch
verification, and what happens to the old domain.

**One change to the running order is worth making.** Register
`allfrequencies.app` *before* taking the current site down (§5 before §2).
Registration is the only step that can fail outright — if the name is already
taken the whole plan changes — and the DNS and email-domain verification that
follow it have lead times measured in hours. Doing it first means the site is
dark for an afternoon rather than a weekend. Nothing else in the sequence
changes.

---

## 1. Decisions to settle before any work starts

| # | Decision | Notes / recommendation |
|---|---|---|
| 1.1 | Is `allfrequencies.app` actually available? | Check at Porkbun before anything else. Have a second choice ready (`allfrequencies.fm`, `allfrequencies.co`, `all-frequencies.app`). |
| 1.2 | Canonical host: apex or `www`? | **Recommendation: apex `https://allfrequencies.app`**, with `www` 308-redirecting to it. Today the two are inconsistent — the docs and scripts assume `https://www.rebalance-gender.app` while the app code falls back to the bare `https://rebalance-gender.app` (`src/app/layout.tsx:31`). Pick one now and make every fallback match it. |
| 1.3 | Does the strapline change? | The name currently carries the mission; "All Frequencies" doesn't. The description — "A directory of women and gender-expansive producers and DJs in electronic music" (`src/app/layout.tsx:33`) — now does all that work alone, in the tab title's shadow, on the social card and in search results. Keep it verbatim, and expect it to matter more than it did. |
| 1.4 | What is the new logo? | Two marks exist today and they don't match each other: the header lockup is two mixing-desk faders that slide level on hover — a literal "rebalance" (`src/app/layout.tsx:99–154`, `src/app/globals.css:253–268`) — while the favicon and Apple icon are a white wave on a violet→magenta gradient (`src/app/icon.svg`, `src/app/apple-icon.tsx`). The fader metaphor dies with the old name. "All Frequencies" points at a spectrum: an EQ curve, a full band of bars, the existing wave. There is already a small equalizer motif in the codebase (`.eq-mini`, `src/app/globals.css:271–286`) that could grow into the mark. **Recommendation: one mark, used everywhere** — header, favicon, Apple icon, OG card. Keep the violet→magenta gradient (`#6a4dff` → `#ff2d9b`); it is the visual signature and it survives the rename intact. |
| 1.5 | What happens to `rebalance-gender.app`? | **Recommendation: keep it registered for at least 12 months** and redirect every path to the new domain (§9). Inbound links, anything indexed, and — in the first 48 hours — live email verification links all point at it. |
| 1.6 | Does the local checkout get renamed too? | **Recommendation: no, not as part of this.** See §10 — it breaks more than it tidies. |

---

## 2. Take the current site offline

Serve a holding page rather than letting the domain go dark. A dead domain
looks broken; a holding page says the name changed and where it went — and
later becomes the redirect target's stepping stone.

1. Create a branch with a minimal maintenance page (a static route, or set
   the root route to render a single card: new name, one line of
   explanation, "back shortly").
2. Deploy that branch to production on Vercel, or promote it as the
   production deployment. Keep the real production deployment in the
   deployment list — it is the rollback (§11).
3. Alternatively, if the intent is a hard stop rather than a holding page:
   Vercel → Project → Settings → **Deployment Protection** → password-protect
   production. Faster, but visitors get an auth prompt, which reads as broken.

Worth knowing while it is down:

- **Submissions stop.** `/submit` and `/artist/<id>/revise` are unreachable,
  so the moderation queue receives nothing. Verification emails already sent
  have a 48-hour expiry and point at the old domain — the redirect in §9 is
  what keeps them working.
- **The data pipeline is unaffected.** Every script in `scripts/` talks to
  Supabase directly, not through the site, so harvesting, enrichment and
  scoring can carry on all the way through the rebrand.
- **Nothing needs to change in Supabase yet.** The database is untouched by
  the rebrand except for the About text (§3.4).

---

## 3. Rename the site in code

### 3.1 Central strings and the header lockup

| File | What |
|---|---|
| `src/app/layout.tsx:31` | `SITE_URL` fallback → `https://allfrequencies.app` |
| `src/app/layout.tsx:38–50` | `metadata.title`, `openGraph.siteName`, `openGraph.title`, `twitter.title` |
| `src/app/layout.tsx:96` | `aria-label="Rebalance Gender — home"` |
| `src/app/layout.tsx:99–154` | The inline fader SVG — replaced by the new mark (1.4) |
| `src/app/layout.tsx:155–158` | The stacked wordmark: `<span>Rebalance</span>` / `<span className="grad-text">Gender</span>`. "All Frequencies" splits the same way — plain "All", gradient "Frequencies" — so the two-line lockup and its type scale survive as-is |
| `src/app/globals.css:253–268` | The `.fader-mark` hover animation and its comment ("a literal *rebalance*"); replaced or removed with the mark |
| `src/app/globals.css:287–302` | The `prefers-reduced-motion` block that disables that animation — must be updated in step with it |

### 3.2 Per-page browser-tab titles

Nine files set a title containing the site name — the `| Rebalance Gender`
suffix pattern:

`src/app/about/page.tsx:5`, `src/app/submit/page.tsx:11`,
`src/app/artist/[id]/page.tsx:31`, `src/app/artist/[id]/edit/page.tsx:43`,
`src/app/artist/[id]/revise/page.tsx:22`,
`src/app/organisation/[id]/page.tsx:33`,
`src/app/admin/organisations/[id]/page.tsx:36`.

**Do this once rather than nine times.** Add a title template to the root
layout —

```ts
title: { default: "All Frequencies", template: "%s | All Frequencies" },
```

— and reduce each page to its own part of the title (`"About"`, `artist.name`).
The suffix then lives in one place and the next rename is a one-line change.
Note the current suffixes are inconsistent anyway (`·` on About, `—` on
Submit, `|` elsewhere); the template settles that too.

### 3.3 Social card and icons

- `src/app/opengraph-image.tsx` — the `alt` text (line 5–8), the two wordmark
  spans (line 86 and its "Gender" sibling), and the fader shapes that mirror
  the header lockup.
- `src/app/twitter-image.tsx` — re-exports the OG image, so it follows
  automatically. No edit needed.
- `src/app/icon.svg`, `src/app/apple-icon.tsx` — the new mark (1.4).
- Both image routes are generated at request time by `next/og`, so they
  refresh on deploy. Social platforms cache aggressively: re-scrape the new
  URL in each debugger after launch (§8).

### 3.4 The About page text is **not** in the repo

`src/app/about/page.tsx` renders admin-authored HTML from the Supabase
`site_content` table (key `about`), edited at **/admin/about**. The only
string in the file is the fallback used when that row is missing
(`src/app/about/page.tsx:14`).

So: rewrite the About copy in the admin panel, and update the fallback and
the page's own `description` (lines 5–7) in code. Easy to miss, because a
repo-wide find-and-replace reports the file as done.

Check the same admin surface for anything else that names the site: the
homepage stat copy driven by `site_stats` (`scripts/update-artist-count.mjs`)
and any other `site_content` keys.

### 3.5 Outbound identity — user agents and contact URLs

These are how the project introduces itself to other people's servers. Two of
them are close to obligations: MusicBrainz requires an accurate, contactable
user agent, and Discogs expects the same.

| File | Current value |
|---|---|
| `src/lib/search-providers.ts:36–37` | `RebalanceGenderDirectory/1.0 (<site url>)` |
| `src/lib/scrape-images.ts:255` | `RebalanceGenderBot/1.0` |
| `src/lib/resolve-url-redirects.ts:226` | `RebalanceGenderBot/1.0` |
| `scripts/sync-linktree.mjs:202`, `scripts/sync-bandcamp.mjs:550`, `scripts/store-images.mjs:259` | `RebalanceGenderBot/1.0` |
| `scripts/sync-discogs.mjs:243,311`, `scripts/export-discogs-label.mjs:134` | `RebalanceGender/1.0 +https://rebalance-gender.com` — note the **`.com`**, which has never been the site's domain |
| `scripts/enrich-musicbrainz.mjs:121` | `WomenInElectronicMusicDirectory/1.0 (maisiemeson@gmail.com)` — two names out of date |

### 3.6 Hard-coded domain fallbacks

Ten scripts default `SITE_URL` to `https://www.rebalance-gender.app` when the
env var is missing — `sync-linktree.mjs:166`, `sync-bandcamp.mjs:221`,
`sync-soundcloud.mjs:301`, `resolve-link-redirects.mjs:165`,
`integrate-harvested-links.mjs:197`, `export-lastfm-links.mjs:56`,
`export-link-backfill-candidates.mjs:93`,
`export-pending-hoer-artists.mjs:80`, `export-hoer-sc-followees.mjs:59` —
plus `src/app/api/admin/reports/harvest-failures/route.ts:11` and
`src/lib/search-providers.ts:37` in the app. Point all of them at the
canonical host chosen in 1.2, and use the *same* string in every one.

Related: `scripts/apply-pending-hoer-decisions.mjs:98` parses artist URLs and
accepts both host forms; add the new domain there. The CSV column header
`rebalance_gender_url` in `sync-bandcamp.mjs:964` and `sync-linktree.mjs:706`
is a rename too — it appears in generated review sheets, so any
half-processed sheet from before the rename will no longer match. Finish or
discard outstanding sheets first.

`parseArtistIdInput` (`src/lib/duplicate-of.ts`) is host-agnostic, so pasted
links keep working from either domain. Its test fixtures use
`rebalancegender.com` (`src/lib/duplicate-of.test.ts:21–24,37`) — cosmetic,
but worth changing with everything else.

### 3.7 Legacy name still in the emails

`src/lib/email.ts` never got updated from the *previous* rename. Every
verification email says **"the Women in Electronic Music directory"** (lines
54, 55, 76), and the module doc-comment gives
`https://womeninelectronicmusic.com` as the example origin (line 9). Fix all
four with this rebrand. The email subjects and the sender name (§7.2) are the
other visitor-facing strings.

The same stale name heads `documentation/CONTEXT.md:1`, whose overview also
claims the site is "live at rebalance-gender.com" (line 12) — wrong TLD.

### 3.8 Repo metadata and documentation

- `package.json:2` — `"name": "rebalance-gender"` → `"all-frequencies"`.
- `README.md:1` — title and description.
- `documentation/CONTEXT.md` — title, the live URL, the registrar/deployment
  section.
- `documentation/OPERATIONS.md` — every `rebalance-gender.app` in the auth,
  redirect-URL and SMTP tables (the `/login` URL at line 24, the URL
  Configuration table, and the SMTP settings table). This file is the
  runbook for §7; update it as those steps are done, not before.
- Comments across `scripts/` say "run from the rebalance-gender/ folder".
  These describe the *local directory*, which is not being renamed (§10) —
  leave them, or correct them to the actual folder name
  (`rebalance-gender-repo`) as a separate tidy-up.

### 3.9 Verify before merging

```bash
npm run lint && npm test && npm run build
```

Then `grep -rniE "rebalance|women in electronic" src scripts public *.json *.md`
and confirm every remaining hit is deliberate.

---

## 4. Rename the GitHub repo and make it private

Currently `https://github.com/maisiebird2/rebalance-gender` (public).

1. **Rename** — GitHub → repo → Settings → General → Repository name →
   `allfrequencies`. GitHub keeps redirecting the old path for Git
   operations, so nothing breaks immediately, but update the remote anyway:

   ```bash
   git remote set-url origin https://github.com/maisiebird2/allfrequencies.git
   ```

   One `set-url` covers **all five checkouts** — the primary one and the four
   worktrees under `.claude/worktrees/` share a single `.git`.

2. **Make private** — Settings → General → Danger Zone → Change visibility.
   Before clicking:
   - **Vercel keeps deploying.** The GitHub integration is installed on the
     same account, so a private repo deploys exactly as a public one did.
     Confirm the Vercel project still shows a connected Git repository
     immediately afterwards; the rename can leave the connection stale, in
     which case reconnect it under Project → Settings → Git.
   - **No CI to worry about.** There is no `.github/` directory, so no
     Actions minutes become billable.
   - Stars, watchers and forks lose access. Existing forks stay public and
     keep the code as of the fork — going private does not retract what has
     already been published.
   - Anything public that links to the repo (the README of another project,
     the About page) becomes a 404 for everyone else.
3. Merge the rename branch **before** the visibility change, so no PR is in
   flight while permissions move.

---

## 5. Register `allfrequencies.app` — do this first

Porkbun already holds the current domain, so keep both in one account.

1. Check availability and register. Watch the renewal price, not just the
   first-year price.
2. **`.app` is HSTS-preloaded at the TLD level.** Every browser refuses
   plain HTTP to any `.app` domain, with no clickable warning to bypass —
   the site simply will not load until a valid certificate is live. In
   practice that means: DNS first, certificate issued by Vercel, *then* test.
   A "site is down" panic ten minutes after the DNS change is usually just
   the certificate still being issued. (The current domain is `.app` too, so
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
   §7.2. Redeploy — `NEXT_PUBLIC_*` values are inlined at build time, so an
   env change without a rebuild changes nothing.
5. Update the local `.env.local` to match. The worktrees symlink it, so one
   edit covers them all.
6. Promote the real application deployment back to production, replacing the
   holding page from §2.

**Nothing to change in the CSP.** `src/proxy.ts` builds the policy from
`'self'` plus the Supabase URL, Cloudflare Turnstile, Bandcamp and
SoundCloud — no site domain is named, so the header follows the move for
free. Same for `next.config.mjs` `images.remotePatterns` (third-party image
hosts only) and every Supabase Storage image URL (served from the Supabase
domain).

---

## 7. External services that hold the old name

The step most likely to be forgotten, because none of it lives in the repo.
`documentation/OPERATIONS.md` is the existing runbook for items 7.1–7.2.

### 7.1 Supabase Auth

Authentication → **URL Configuration**:

| Setting | New value |
|---|---|
| Site URL | `https://allfrequencies.app` |
| Redirect URLs | add `https://allfrequencies.app/reset-password` (keep `http://localhost:3000/**`; keep the old domain's entry until the redirect period ends) |

Leave the Reset Password email template's `{{ .SiteURL }}` alone — it picks
up the new Site URL automatically. If Site URL is not changed, password
recovery links keep pointing at the old domain and appear to do nothing.

### 7.2 Resend (transactional and auth email)

1. Resend → Domains → add `allfrequencies.app` and add the DKIM/SPF (and
   DMARC, if used) records it gives you to Porkbun DNS. Verification is the
   slowest part of the whole move — allow for propagation.
2. Once verified, set `RESEND_FROM_ADDRESS=noreply@allfrequencies.app` in
   Vercel and `.env.local`.
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

**Test the submission form end to end after this.** A Turnstile
misconfiguration fails *silently* — the widget renders, the visitor submits,
and verification rejects the token server-side. This project has been bitten
by exactly that before.

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

- [ ] Home page loads, artist count copy is correct, images render
- [ ] An artist page and an organisation page load; SoundCloud/Bandcamp
      embeds play (CSP `frame-src`)
- [ ] About page shows the **rewritten** copy (§3.4), not the fallback
- [ ] Browser tab titles read "All Frequencies" on every route type: home,
      artist, organisation, about, submit, admin
- [ ] Favicon and Apple touch icon are the new mark; hard-refresh, favicons
      cache hard
- [ ] Submit an artist end to end: Turnstile passes → verification email
      arrives from the new sender → the link points at the new domain →
      confirming lands the row in the moderation queue
- [ ] Login, sign out, and "Forgot password?" → recovery email → set a new
      password → back to `/login`
- [ ] Admin panel: moderation queue, missing-links, `/admin/about`,
      `/admin/settings`
- [ ] Old-domain redirects: `rebalance-gender.app` → new home, and a deep
      link such as `/artist/<uuid>` → the same path on the new domain
- [ ] Security headers still present (`curl -sI` for `X-Frame-Options`,
      `Content-Security-Policy`) — see `documentation/SECURITY-HEADERS.md`
- [ ] OG card: re-scrape in the social debuggers and confirm the new wordmark
- [ ] A 404 route still renders correctly

---

## 9. The old domain

Add `rebalance-gender.app` and `www.rebalance-gender.app` to the *same*
Vercel project and configure them to **redirect to the new domain, preserving
the path** (Vercel's domain redirect does this; 308 keeps method and passes
search-engine signals). Artist and organisation IDs are database UUIDs and
do not change, so every existing deep link survives the move intact.

Keep it registered and redirecting for at least 12 months. Renew auto-renew
on it now, while it still matters — an expired redirect domain is how link
rot starts, and a lapsed one can be picked up by anyone.

---

## 10. What *not* to rename

The local checkout is `~/Claude/Projects/Rebalance Gender/rebalance-gender-repo`.
Leave it alone, at least for now:

- Four active worktrees are registered by absolute path under
  `.claude/worktrees/`. Renaming a parent directory breaks all of them.
- The output-file convention resolves `<repo>/../output files` through
  `scripts/lib/output-path.mjs` and the mirrored constant in
  `scripts/review_candidates.py`. It follows a rename automatically, but the
  literal path is written into `CLAUDE.md` and
  `documentation/OUTPUT-FILE-LOCATION.md`, which would then be wrong.
- `.env.local` and `node_modules` are symlinked from each worktree into the
  primary checkout.

If the folder name should match the brand, do it as its own task: remove the
worktrees, rename, re-create them, then update the paths in `CLAUDE.md` and
the docs. It has nothing to do with the public rebrand.

---

## 11. Rollback

Nothing here is one-way until the old domain expires.

| If | Then |
|---|---|
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
| 1 | Settle §1, especially availability (1.1) and the logo (1.4) | Yes — everything else assumes them |
| 2 | Register `allfrequencies.app`; lock, privacy, auto-renew (§5) | Yes |
| 3 | Start Resend domain verification (§7.2) — begin early, it is the slowest | No, runs in parallel |
| 4 | Do the code rename on a branch, build and test green (§3) | No |
| 5 | Take the current site offline behind the holding page (§2) | — |
| 6 | Add the domain in Vercel, DNS at Porkbun, wait for the certificate (§6) | Yes |
| 7 | Update Vercel env vars; merge the rename branch; deploy (§3, §6) | Yes |
| 8 | Supabase Auth URLs, Resend sender, Turnstile hostnames (§7) | Yes |
| 9 | Rewrite the About copy in `/admin/about` (§3.4) | No |
| 10 | Redirect the old domain (§9) | No |
| 11 | Rename the GitHub repo and make it private (§4) | No — safest once everything is deployed and stable |
| 12 | Verification pass (§8); Search Console (§7.4) | — |

Steps 5–8 are the only window in which the site is unavailable. Done in one
sitting, with the domain already registered and Resend verification already
under way, that window is a couple of hours — most of it spent waiting for a
certificate.
