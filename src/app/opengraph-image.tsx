import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";

// Social share card (og:image). Mirrors the header lockup — the five-bar
// spectrum mark plus the stacked "All / Frequencies" wordmark — on the After
// Dark background, with the signature violet→magenta underglow along the
// bottom. "Frequencies" is long: at 128px it sits at roughly 740px beside a
// 130px mark inside the 1008px of usable width, so check it after any change
// to the size or tracking rather than letting it wrap.
export const alt =
  "All Frequencies — a directory of women and gender-expansive producers and DJs in electronic music";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type FontDef = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal";
};

// Space Grotesk (self-hosted at the app's runtime via fontsource on jsDelivr).
// WOFF, not WOFF2 — Satori can't decode WOFF2. Fails soft: if the fetch is
// unavailable the card still renders in next/og's bundled default font.
async function loadFont(weight: 400 | 700): Promise<FontDef | null> {
  try {
    const res = await fetch(
      `https://cdn.jsdelivr.net/npm/@fontsource/space-grotesk@5/files/space-grotesk-latin-${weight}-normal.woff`,
    );
    if (!res.ok) return null;
    return { name: "Space Grotesk", data: await res.arrayBuffer(), weight, style: "normal" };
  } catch {
    return null;
  }
}

export default async function OpengraphImage() {
  const fonts = (await Promise.all([loadFont(700), loadFont(400)])).filter(
    (f): f is FontDef => f !== null,
  );

  const bar: CSSProperties = {
    width: 18,
    borderRadius: 9,
    backgroundImage: "linear-gradient(0deg,#6a4dff,#ff2d9b)",
  };

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: "#0a0910",
          fontFamily: "Space Grotesk, sans-serif",
          padding: "0 96px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 44 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, width: 130, height: 170 }}>
            <div style={{ ...bar, height: 66 }} />
            <div style={{ ...bar, height: 118 }} />
            <div style={{ ...bar, height: 170 }} />
            <div style={{ ...bar, height: 104 }} />
            <div style={{ ...bar, height: 78 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span
              style={{
                fontSize: 128,
                fontWeight: 700,
                lineHeight: 1,
                letterSpacing: -3,
                color: "#f3f0fa",
              }}
            >
              All
            </span>
            <span
              style={{
                fontSize: 128,
                fontWeight: 700,
                lineHeight: 1,
                letterSpacing: -3,
                backgroundImage: "linear-gradient(92deg,#7c5cff,#ff2d9b)",
                backgroundClip: "text",
                WebkitBackgroundClip: "text",
                color: "transparent",
              }}
            >
              Frequencies
            </span>
          </div>
        </div>
        <span
          style={{
            marginTop: 48,
            maxWidth: 940,
            fontSize: 33,
            fontWeight: 400,
            lineHeight: 1.35,
            color: "#a49cc0",
          }}
        >
          A directory of women and gender-expansive producers and DJs in
          electronic music.
        </span>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 8,
            backgroundImage:
              "linear-gradient(90deg,rgba(124,92,255,0) 0%,#7c5cff 30%,#ff2d9b 70%,rgba(255,45,155,0) 100%)",
          }}
        />
      </div>
    ),
    { ...size, fonts: fonts.length ? fonts : undefined },
  );
}
