import 'server-only';

import path from 'node:path';
import { Font } from '@react-pdf/renderer';

/**
 * Geist font registration for the client-facing proposal PDF (BAL-385).
 *
 * react-pdf can only use fonts it EMBEDS via {@link Font.register} — it cannot read
 * the app's Geist web font. So the genuine brand type ships as repo assets: static
 * TrueType weights (400/500/600/700) instanced from the official variable Geist
 * (OFL, see ./fonts/OFL.txt) and registered from disk here.
 *
 * The assets are resolved from `process.cwd()` (the web app root in dev, test, and
 * the Vercel serverless function — see `outputFileTracingIncludes` in
 * `next.config.js`, which bundles the .ttf files into the download route). If the
 * fonts are ever missing at render time, react-pdf THROWS — we deliberately do NOT
 * silently fall back to Helvetica; the PDF must stay brand-faithful.
 */

const FONT_DIR = path.join(process.cwd(), 'src/lib/project-request/proposal/pdf/fonts');

/** The registered PDF font family. */
export const PDF_FONT_FAMILY = 'Geist';

let registered = false;

/** Register Geist with react-pdf exactly once per process (idempotent). */
export function ensurePdfFontsRegistered(): void {
  if (registered) {
    return;
  }
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: path.join(FONT_DIR, 'Geist-400.ttf'), fontWeight: 400 },
      { src: path.join(FONT_DIR, 'Geist-500.ttf'), fontWeight: 500 },
      { src: path.join(FONT_DIR, 'Geist-600.ttf'), fontWeight: 600 },
      { src: path.join(FONT_DIR, 'Geist-700.ttf'), fontWeight: 700 },
    ],
  });
  // Geist is generously spaced; wrap whole words rather than hyphenating mid-word.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
