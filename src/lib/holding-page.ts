/**
 * lib/holding-page.ts
 *
 * The maintenance holding page that src/proxy.ts serves when HOLDING_PAGE=1.
 *
 * Self-contained on purpose: a complete HTML document with inline styles, no
 * scripts, no data fetching and no dependency on the root layout, so it
 * cannot fail whatever state the deployment behind it is in. The proxy sends
 * it with a 503 and a Retry-After header, so search engines treat the outage
 * as temporary and leave the existing index alone; a 200 holding page would
 * be indexed as the new homepage.
 *
 * Flip it without a deploy of code: Vercel → Settings → Environment
 * Variables → add HOLDING_PAGE=1 for Production, then Redeploy (env changes
 * never apply to a running deployment). Remove the variable and redeploy to
 * come back. HOLDING_MESSAGE optionally replaces the one-line explanation
 * for a given window. See documentation/REBRAND-ALL-FREQUENCIES-v2.md §2.
 */

/**
 * Routes that keep working while the holding page is up: the confirmation
 * links in emails already sent (/verify, /api/*), and everything moderation
 * needs (/login, /reset-password, /admin/*, the edit and revise routes).
 */
export const HOLDING_EXEMPT =
  /^\/(verify|api\/|login|reset-password|admin(\/|$)|artist\/[^/]+\/(edit|revise)(\/|$))/;

export const HOLDING_RETRY_AFTER_SECONDS = 3600;

const DEFAULT_MESSAGE =
  "This directory is moving to a new name and a new home. It will be back shortly.";

export function isHoldingExempt(pathname: string): boolean {
  return HOLDING_EXEMPT.test(pathname);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The full document. `message` defaults to HOLDING_MESSAGE, then to the built-in line. */
export function holdingPageHtml(message?: string): string {
  const line = escapeHtml(
    (message ?? process.env.HOLDING_MESSAGE ?? "").trim() || DEFAULT_MESSAGE
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>All Frequencies — back shortly</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
  html { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0a0910; color: #f3f0fa;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main {
    max-width: 30rem; margin: 1.5rem; padding: 2.5rem 2.25rem;
    border: 1px solid rgba(255,255,255,0.1); border-radius: 1rem;
    background: rgba(255,255,255,0.03);
  }
  h1 { margin: 0 0 1.25rem; font-size: 2rem; line-height: 0.96; letter-spacing: -0.02em; display: flex; flex-direction: column; }
  h1 b {
    background: linear-gradient(92deg, #7c5cff, #ff2d9b);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  p { margin: 0 0 0.75rem; line-height: 1.5; color: #d4cfe6; }
  p.small { font-size: 0.875rem; color: #a49cc0; }
  .glow { position: fixed; left: 0; right: 0; bottom: 0; height: 6px;
    background: linear-gradient(90deg, rgba(124,92,255,0) 0%, #7c5cff 30%, #ff2d9b 70%, rgba(255,45,155,0) 100%); }
</style>
</head>
<body>
<main>
  <h1><span>All</span><b>Frequencies</b></h1>
  <p>${line}</p>
  <p class="small">Links in confirmation emails you have already received still work.</p>
</main>
<div class="glow" aria-hidden="true"></div>
</body>
</html>
`;
}
