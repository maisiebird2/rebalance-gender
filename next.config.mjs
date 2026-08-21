/**
 * Security headers live in two places, deliberately:
 *
 *   - The static ones are here, because they are the same on every response
 *     and this applies them to static assets too (the proxy matcher skips
 *     /_next/static).
 *   - Content-Security-Policy is in src/proxy.ts, because it carries a
 *     per-request nonce and therefore cannot be a constant.
 *
 * See documentation/SECURITY-HEADERS.md.
 */
const securityHeaders = [
  // Stop the browser second-guessing declared Content-Types. Without it, a
  // response we serve as text/plain can be sniffed and run as script.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Clickjacking. The CSP's frame-ancestors directive is the modern control
  // and supersedes this, but X-Frame-Options is kept for browsers that don't
  // implement frame-ancestors. The two must agree: 'none' <-> DENY.
  { key: "X-Frame-Options", value: "DENY" },

  // Send the full URL only to same-origin destinations; cross-origin gets the
  // bare origin. Artist pages link out to a lot of third-party profiles, and
  // the path can carry an artist id we have no reason to hand over.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Nothing here uses these, so refuse them rather than leaving them to a
  // third-party embed. Note the SoundCloud and Bandcamp players are iframes:
  // this policy applies to them too, and neither needs any of these.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  images: {
    unoptimized: true,
    remotePatterns: [
      // SoundCloud avatar/artwork CDN — used for cached profile pictures
      { protocol: "https", hostname: "i1.sndcdn.com" },
      { protocol: "https", hostname: "*.sndcdn.com" },

      // Add a pattern here for each new source used to populate
      // artists.profile_image_url (e.g. Instagram's CDN, Bandcamp's
      // image host, etc.) — next/image refuses to load images from
      // domains not listed here.
      { protocol: "https", hostname: "www.bpitch.de" },
    ],
  },
};

export default nextConfig;
