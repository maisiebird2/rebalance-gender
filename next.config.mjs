/** @type {import('next').NextConfig} */
const nextConfig = {
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
