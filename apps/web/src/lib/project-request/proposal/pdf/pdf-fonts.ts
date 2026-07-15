import 'server-only';

import { existsSync } from 'node:fs';
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
 * The .ttf files live at `<webAppRoot>/src/lib/project-request/proposal/pdf/fonts`,
 * but the process cwd differs by context, so we resolve against the first candidate
 * that actually contains the fonts:
 *   - Vercel serverless function root (the .ttf files are traced in via
 *     `outputFileTracingIncludes` in `next.config.js`) and `next dev` started from
 *     `apps/web` → cwd IS the web app root, so `cwd/<subpath>` matches.
 *   - Vitest / the monorepo test runner runs from the REPO ROOT → the fonts are at
 *     `cwd/apps/web/<subpath>`.
 * If the fonts are missing in every candidate, react-pdf THROWS at render time — we
 * deliberately do NOT silently fall back to Helvetica; the PDF must stay brand-faithful.
 */

const FONT_SUBPATH = path.join('src', 'lib', 'project-request', 'proposal', 'pdf', 'fonts');

const FONT_DIR_CANDIDATES = [
  path.join(process.cwd(), FONT_SUBPATH),
  path.join(process.cwd(), 'apps', 'web', FONT_SUBPATH),
];

function resolveFontDir(): string {
  const found = FONT_DIR_CANDIDATES.find((dir) => existsSync(path.join(dir, 'Geist-400.ttf')));
  return found ?? FONT_DIR_CANDIDATES[0] ?? path.join(process.cwd(), FONT_SUBPATH);
}

const FONT_DIR = resolveFontDir();

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
