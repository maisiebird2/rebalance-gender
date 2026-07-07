/**
 * Fixed, dark-mode-only ambient background: two feTurbulence "smoke" layers
 * — magenta drifting from the top-right, blue-violet from the bottom-left —
 * masked so both thin out through the middle where the content sits.
 *
 * The fractal noise is rendered ONCE by the browser; the slow drift is a CSS
 * transform on the pre-rendered layers (see .smk / smoke-drift in globals.css),
 * so it stays GPU-composited and cheap. Hidden entirely in light mode.
 */
export default function SmokeBackdrop() {
  return (
    <svg
      className="smoke-layer"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 1200 800"
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        pointerEvents: "none",
      }}
    >
      <defs>
        <filter id="smokeMag" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.009 0.014"
            numOctaves={4}
            seed={7}
            stitchTiles="stitch"
            result="t"
          />
          <feColorMatrix
            in="t"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.6 -0.34"
            result="m"
          />
          <feComposite in="SourceGraphic" in2="m" operator="in" />
        </filter>
        <filter id="smokeVio" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.008 0.013"
            numOctaves={4}
            seed={23}
            stitchTiles="stitch"
            result="t"
          />
          <feColorMatrix
            in="t"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.6 -0.34"
            result="m"
          />
          <feComposite in="SourceGraphic" in2="m" operator="in" />
        </filter>
        <radialGradient id="poolMag" cx="80%" cy="14%" r="85%">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <radialGradient id="poolVio" cx="16%" cy="90%" r="90%">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0.3" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id="maskMag">
          <rect width="1200" height="800" fill="url(#poolMag)" />
        </mask>
        <mask id="maskVio">
          <rect width="1200" height="800" fill="url(#poolVio)" />
        </mask>
      </defs>
      <g mask="url(#maskVio)">
        <rect
          className="smk smk2"
          x="-200"
          y="-150"
          width="1600"
          height="1100"
          fill="#6a4dff"
          filter="url(#smokeVio)"
          opacity="0.6"
        />
      </g>
      <g mask="url(#maskMag)">
        <rect
          className="smk smk1"
          x="-200"
          y="-150"
          width="1600"
          height="1100"
          fill="#ff2d9b"
          filter="url(#smokeMag)"
          opacity="0.62"
        />
      </g>
    </svg>
  );
}
