import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { helpAnchor } from './anchor';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Seeds the help fixture once per run and publishes its anchor Monday to the workers. */
export default function globalSetup(): void {
  if (!process.env.E2E_TEST_SECRET) {
    throw new Error(
      'E2E_TEST_SECRET is not set. Export the same value the web dev server runs with ' +
        '(see e2e/help-screenshots/README.md).'
    );
  }
  const anchor = helpAnchor();
  execFileSync('pnpm', ['--filter', '@balo/db', 'help:seed', `--anchor=${anchor}`], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  process.env.HELP_ANCHOR = anchor;
}
