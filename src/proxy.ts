// Proxy: two jobs on every request.
//
//   1. Refresh the Supabase auth session, so Server Components always see a
//      valid (not expired) session cookie.
//      See: https://supabase.com/docs/guides/auth/server-side/nextjs
//   2. Emit the Content-Security-Policy, which lives here rather than in
//      next.config.mjs because it carries a per-request nonce.
//
// The other security headers are static and set in next.config.mjs.
// See documentation/SECURITY-HEADERS.md for the reasoning behind each
// directive and how to extend the policy when a new embed is added.
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Build the CSP for one request.
 *
 * The nonce is what lets script-src stay strict. Next.js injects inline
 * <script> tags on every page to stream the RSC payload; rather than allow
 * those with 'unsafe-inline' (which would allow an injected script just as
 * readily), we mint a nonce per request and Next stamps it onto its own
 * inline scripts. Next finds the nonce by reading it back off the
 * Content-Security-Policy request header we set below — hence setting it on
 * the request as well as the response.
 *
 * This costs no caching. A per-request nonce can't be statically rendered,
 * but every route here is dynamic already: the root layout calls getViewer(),
 * which reads cookies, opting the whole tree out of static rendering.
 */
function buildCsp(nonce: string): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isDev = process.env.NODE_ENV === "development";

  return [
    `default-src 'self'`,

    // 'unsafe-eval' is dev-only: the Next dev server needs it for HMR, and a
    // production build does not. Turnstile's api.js is loaded by the widget
    // at runtime, so it needs its host listed — it does not get the nonce.
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com${
      isDev ? " 'unsafe-eval'" : ""
    }`,

    // 'unsafe-inline' for styles is the pragmatic choice, not an oversight:
    // Tailwind and Next both inject inline style attributes, nonces don't
    // apply to those, and injected CSS is a far weaker primitive than
    // injected script. Revisit only if a style-based exfiltration path
    // becomes relevant.
    `style-src 'self' 'unsafe-inline'`,

    // Deliberately permissive. Artist photos are re-hosted to Supabase
    // Storage, but pickArtistImage falls back to the original source_url,
    // and those come from a tail of hosts that grows every time a new
    // platform is harvested (sndcdn, bcbits, scdn, linktr.ee, mzstatic,
    // ytimg so far). A host allowlist here would silently break photos on
    // each new source; images cannot execute, so the trade is worth it.
    `img-src 'self' data: blob: https:`,

    // next/font self-hosts at build time, so no third-party font hosts.
    `font-src 'self' data:`,

    // The browser Supabase client (login, password reset) talks to the
    // project URL; Turnstile posts its challenge result to Cloudflare.
    `connect-src 'self' ${supabaseUrl} https://challenges.cloudflare.com`,

    // Every iframe the site embeds. Turnstile renders its widget in one;
    // the artist page embeds SoundCloud players and Bandcamp albums.
    `frame-src https://challenges.cloudflare.com https://bandcamp.com https://w.soundcloud.com`,

    // Nothing may frame us. Mirrors X-Frame-Options: DENY in next.config.mjs.
    `frame-ancestors 'none'`,

    // Stop an injected <base> retargeting every relative URL on the page.
    `base-uri 'self'`,

    // Forms may only post back to us — including the server actions behind
    // the admin panel and the edit form.
    `form-action 'self'`,

    // No <object>/<embed>/<applet>.
    `object-src 'none'`,

    `upgrade-insecure-requests`,
  ].join("; ");
}

/**
 * Request headers for the downstream render: the caller's own headers, plus
 * the nonce (as x-nonce, should a component ever need it) and the CSP that
 * Next reads the nonce out of.
 *
 * Rebuilt from `request` on each call rather than snapshotted once, because
 * the Supabase cookie handler mutates request.cookies and those mutations
 * have to reach the render.
 */
function requestHeadersWith(
  request: NextRequest,
  nonce: string,
  csp: string
): Headers {
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  return headers;
}

export async function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  let response = NextResponse.next({
    request: { headers: requestHeadersWith(request, nonce, csp) },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          // Write updated cookies back to both the request and response so
          // that subsequent proxy/server components see the fresh token.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({
            request: { headers: requestHeadersWith(request, nonce, csp) },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refreshing the session will update the cookie if a token was rotated.
  await supabase.auth.getUser();

  // Report-only is the escape hatch: set CSP_REPORT_ONLY=1 in Vercel to
  // downgrade enforcement to reporting without a deploy, if a policy problem
  // ever surfaces in the wild. Violations then appear in the browser console
  // instead of blocking the resource.
  const headerName =
    process.env.CSP_REPORT_ONLY === "1"
      ? "content-security-policy-report-only"
      : "content-security-policy";
  response.headers.set(headerName, csp);

  return response;
}

export const config = {
  matcher: [
    // Skip Next.js internals and static assets; run on all other routes.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
