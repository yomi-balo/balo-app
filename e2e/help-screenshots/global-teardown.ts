import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Removes the help fixture after the run so the shared `onboarded-e2e@balo.test` user is not left
 * an expert. Set `HELP_KEEP_FIXTURE=1` to keep it for inspection.
 */
export default function globalTeardown(): void {
  if (process.env.HELP_KEEP_FIXTURE === '1') {
    return;
  }
  execFileSync('pnpm', ['--filter', '@balo/db', 'help:reset'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}
