# Security headers

The site sends five security headers. They live in two places, and the split is
deliberate:

| Header | Set in | Why there |
|---|---|---|
| `X-Content-Type-Options` | `next.config.mjs` | Constant on every response |
| `X-Frame-Options` | `next.config.mjs` | Constant |
| `Referrer-Policy` | `next.config.mjs` | Constant |
| `Permissions-Policy` | `next.config.mjs` | Constant |
| `Content-Security-Policy` | `src/proxy.ts` | Carries a per-request nonce, so it cannot be a constant |

`next.config.mjs` covers static assets too; the proxy matcher deliberately skips
`/_next/static`.

## Why the CSP uses a nonce

Next.js injects inline `<script>` tags on every page to stream the RSC payload.
Allowing those with `'unsafe-inline'` would allow an *injected* script just as
readily, which would leave the policy doing very little for the one thing it is
most needed for here — the site renders a `dangerouslySetInnerHTML` region in
`src/app/about/page.tsx`. (The artist page rendered a second one, the harvested
SoundCloud bio, until that block was removed from public display; the bio block
that replaces it may well render HTML again.)

So `src/proxy.ts` mints a nonce per request and sets it on **both** the response
header and the *request* header. Next.js reads the nonce back off the
`Content-Security-Policy` request header and stamps it onto its own inline
scripts. Setting it only on the response would silently break hydration.

**This costs no caching.** A per-request nonce cannot be statically rendered,
but every route is dynamic already: the root layout calls `getViewer()`, which
reads cookies and opts the whole tree out of static rendering. `next build`
confirms it — every page is marked `ƒ (Dynamic)`; only `icon`, `apple-icon`,
`opengraph-image` and `twitter-image` are static, and the proxy does not run on
those.

## The directives, and why each is what it is

- **`script-src 'self' 'nonce-…' https://challenges.cloudflare.com`** —
  Turnstile's `api.js` is fetched by the widget at runtime and never receives
  the nonce, so its host has to be listed. `'unsafe-eval'` is added in
  development only, where the dev server needs it for HMR.
- **`style-src 'self' 'unsafe-inline'`** — pragmatic, not an oversight. Tailwind
  and Next both emit inline style attributes, nonces do not apply to those, and
  injected CSS is a far weaker primitive than injected script.
- **`img-src 'self' data: blob: https:`** — deliberately permissive. Photos are
  re-hosted to Supabase Storage, but `pickArtistImage` falls back to the
  original `source_url`, and those come from a tail of hosts that grows every
  time a new platform is harvested (sndcdn, bcbits, scdn, linktr.ee, mzstatic,
  ytimg at last count). A host allowlist would silently break artist photos on
  each new source. Images cannot execute, so the trade is worth taking.
- **`connect-src 'self' <supabase-url> https://challenges.cloudflare.com`** —
  the browser Supabase client (login, password reset) and Turnstile's challenge
  post. No websockets: nothing uses Supabase Realtime.
- **`frame-src`** — exactly the three embed hosts: Turnstile, the SoundCloud
  player (`w.soundcloud.com`), and Bandcamp albums.
- **`frame-ancestors 'none'`** — mirrors `X-Frame-Options: DENY`. The two must
  stay in agreement if either is changed.
- **`base-uri 'self'`**, **`form-action 'self'`**, **`object-src 'none'`** —
  stop an injected `<base>` retargeting relative URLs, keep form posts
  (including server actions) on our own origin, and refuse plugin content.

## Adding a new embed or third-party resource

Edit `buildCsp()` in `src/proxy.ts` and add the host to the directive that
governs it — `frame-src` for an iframe, `script-src` for a script, `connect-src`
for a `fetch`/XHR target. Then re-run the verification below. A missing entry
fails closed: the resource is blocked and the browser console names the
directive that did it.

## The report-only escape hatch

Set `CSP_REPORT_ONLY=1` in the Vercel environment to downgrade the header to
`Content-Security-Policy-Report-Only`. Violations then log to the console
instead of blocking. This takes effect on the next request without a code
change or redeploy — it is the fast rollback if a policy problem shows up in
the wild. Unset it to re-enforce.

## Verifying a change

Run a **production** build, not the dev server — dev adds `'unsafe-eval'` and
the script handling differs:

```bash
npm run build && npm start
```

Then, in the browser console on a page with embeds:

```js
// Should print nothing for hosts the policy allows,
// and one entry per host it blocks.
const v = [];
document.addEventListener('securitypolicyviolation',
  e => v.push([e.effectiveDirective, e.blockedURI]));
```

Do not judge an iframe by its `onload` handler — a CSP-blocked frame still
fires `load`, having quietly loaded `about:blank`. Two reliable signals instead:
the `securitypolicyviolation` event above, and whether the frame's document is
cross-origin opaque (a blocked frame is same-origin `about:blank`, so
`f.contentWindow.location.href` is *readable*; a real cross-origin document
throws on access).

Checks worth repeating after any policy edit:

1. Every inline and external `<script>` carries a nonce, and React hydrates.
2. `/submit` — Turnstile loads and produces a `cf-turnstile-response` token.
3. An artist page with both a SoundCloud player and a Bandcamp album renders
   both frames with real documents.
4. A deliberately disallowed host (e.g. `https://example.com` in an iframe) is
   blocked, proving the policy is actually enforcing rather than absent.

All four were confirmed against a production build on 2026-08-19.
