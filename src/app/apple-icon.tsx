import { ImageResponse } from "next/og";

// Apple touch icon (home-screen / pinned tab). PNG is required — Apple
// doesn't render SVG here — so we rasterise the same spectrum-on-gradient
// mark used by the favicon via next/og. iOS masks its own rounded corners,
// so the gradient runs full-bleed and the bars are inset for safe padding.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const bars =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 96 96"><rect x="18" y="53" width="8" height="22" rx="4" fill="#fff"/><rect x="31" y="37" width="8" height="38" rx="4" fill="#fff"/><rect x="44" y="21" width="8" height="54" rx="4" fill="#fff"/><rect x="57" y="41" width="8" height="34" rx="4" fill="#fff"/><rect x="70" y="49" width="8" height="26" rx="4" fill="#fff"/></svg>`,
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
        <img src={bars} width={150} height={150} alt="" />
      </div>
    ),
    { ...size },
  );
}
