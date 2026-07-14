/**
 * Resolved palette + type scale for the client-facing proposal PDF (BAL-385).
 *
 * react-pdf has NO Tailwind / `@theme` bridge and cannot read the app's CSS
 * variables, so the brand colour is resolved to a literal hex here ONCE — the one
 * legitimate exception to "never hardcode colours". `brand` is Balo Blue
 * (`--primary` = `oklch(0.552 0.228 260.9)`), resolved to sRGB. The neutral greys
 * approximate the app's slate token ramp for print.
 *
 * Shared by the PDF document tree and the rich-text mapper so the hex lives in
 * exactly one place (no duplication across modules).
 */
export const PDF_COLORS = {
  /** Balo Blue — resolved from `oklch(0.552 0.228 260.9)`. */
  brand: '#0c64f4',
  brandSoft: '#eff4ff',
  brandBorder: '#c7dbff',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  border: '#e2e8f0',
  subtleBg: '#f8fafc',
  successText: '#15803d',
} as const;

/** Point sizes for the PDF type scale. */
export const PDF_TYPE = {
  title: 20,
  h2: 13,
  h3: 11.5,
  body: 10,
  small: 9,
  label: 8,
  money: 24,
} as const;
