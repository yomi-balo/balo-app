import { ImageResponse } from 'next/og';

export const alt = 'Balo — top Salesforce experts, on demand';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * BAL-493 §12.2 — the marketing surface's OG image, generated (not a committed PNG). Placed at
 * the `(marketing)` route-group level so it's inherited by `/`, `/experts` and
 * `/experts/{username}` — one file establishes the convention for the whole public surface.
 *
 * No font asset and no network fetch: `ImageResponse`'s default font only, no `.woff` loading,
 * no failure mode.
 *
 * ⚠⚠ HARDCODED HEX IS CORRECT IN THIS FILE, AND ONLY THIS FILE. `ImageResponse` renders via
 * Satori, entirely OUTSIDE the CSS cascade — it has no `<html>`/`<body>` and cannot read
 * `globals.css` custom properties (`var(--primary)` etc. resolve to nothing there). The values
 * below are the design reference's own literal palette (`.claude/design-references/
 * marketing-home.jsx:199-206` — `primary: '#2563EB'`, `violet: '#7C3AED'`, `night: '#0B1220'`),
 * not a guess and not a drift from the token system. Any repo-wide "no hardcoded hex" scan
 * should exclude this file for exactly this reason.
 */
export default function Image(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '80px',
        backgroundColor: '#0B1220',
        backgroundImage: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
      }}
    >
      <div
        style={{
          display: 'flex',
          fontSize: 40,
          fontWeight: 700,
          color: '#FFFFFF',
          letterSpacing: -1,
        }}
      >
        Balo
      </div>
      <div
        style={{
          display: 'flex',
          marginTop: 32,
          fontSize: 68,
          fontWeight: 700,
          lineHeight: 1.15,
          color: '#FFFFFF',
          maxWidth: 980,
        }}
      >
        Top Salesforce experts, on demand.
      </div>
      <div
        style={{
          display: 'flex',
          marginTop: 28,
          fontSize: 30,
          color: 'rgba(255,255,255,0.85)',
        }}
      >
        Book a vetted expert by the minute — service fee included.
      </div>
    </div>,
    { ...size }
  );
}
