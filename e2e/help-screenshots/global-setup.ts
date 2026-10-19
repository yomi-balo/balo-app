import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { helpAnchor } from './anchor';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Next's dev server stamps every page response `Cache-Control: no-store, must-revalidate`
 * (`dev` branch of `sendRenderResult` in next/dist/server/base-server.js); a production server
 * emits `s-maxage=…` on the prerendered `/login`, never that exact value.
 */
async function assertProductionServer(baseURL: string): Promise<void> {
  const response = await fetch(`${baseURL}/login`, { redirect: 'manual' });
  if (response.headers.get('cache-control') === 'no-store, must-revalidate') {
    throw new Error(
      `${baseURL} is a Next dev server. Hydration ids drift on it and the console gate fails; ` +
        'stop it and run a production build (see e2e/help-screenshots/README.md).'
    );
  }
}

/** Seeds the help fixture once per run and publishes its anchor Monday to the workers. */
export default async function globalSetup(): Promise<void> {
  if (!process.env.E2E_TEST_SECRET) {
    throw new Error(
      'E2E_TEST_SECRET is not set. Export the same value the web dev server runs with ' +
        '(see e2e/help-screenshots/README.md).'
    );
  }
  await assertProductionServer('http://localhost:3000');
  const anchor = helpAnchor();
  execFileSync('pnpm', ['--filter', '@balo/db', 'help:seed', `--anchor=${anchor}`], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  process.env.HELP_ANCHOR = anchor;
  // Per-run scratch folder where the first scheme of a section stores the clip both schemes use.
  process.env.HELP_CLIP_DIR = mkdtempSync(path.join(os.tmpdir(), 'help-clips-'));
}
