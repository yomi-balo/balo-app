import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pngSize, type PixelSize } from './png-size';
import type { HelpSourceFile } from './types';

// Resolved from this file rather than `process.cwd()`: CI runs web vitest from the repo root while
// a developer runs it from `apps/web`.
const DOCS_DIR = path.resolve(import.meta.dirname, '../../../../../../docs/help');
const PUBLIC_DIR = path.resolve(import.meta.dirname, '../../../../public');

/** Every markdown file in `docs/help`, sorted by filename. */
export function readHelpDocs(): HelpSourceFile[] {
  return readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => ({ filename, source: readFileSync(path.join(DOCS_DIR, filename), 'utf8') }));
}

/** Whether a public path such as `/help/<slug>/<base>-light.png` exists under `apps/web/public`. */
export function publicImageExists(publicPath: string): boolean {
  return existsSync(path.join(PUBLIC_DIR, publicPath));
}

/** The pixel size of a PNG under `apps/web/public`, e.g. `/help/<slug>/<base>-light.png`. */
export function publicImageSize(publicPath: string): PixelSize {
  return pngSize(readFileSync(path.join(PUBLIC_DIR, publicPath)));
}
