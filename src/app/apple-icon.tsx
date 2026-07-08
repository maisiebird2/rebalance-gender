import { ImageResponse } from "next/og";

// Apple touch icon (home-screen / pinned tab). PNG is required — Apple
// doesn't render SVG here — so we rasterize the same wave-on-gradient mark
// used by the favicon via next/og. iOS masks its own rounded corners, so
// the gradient runs full-bleed and the wave is inset for safe padding.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const wave =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 96 96"><path d="M4 48 C16 20 34 20 48 48 C62 76 80 76 92 48" fill="none" stroke="#fff" stroke-width="8.5" stroke-linecap="round"/></svg>`,
  ).toString("base64");

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundImage: "linear-gradient(135deg,#6a4dff,#ff2d9b)",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wave} width={150} height={150} alt="" />
      </div>
    ),
    { ...size },
  );
}
