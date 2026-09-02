import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every environment variable the API reads in production must be documented in
 * `.env.example`.
 *
 * THE GAP THIS CLOSES. `SENTRY_DSN` was read at `src/index.ts` but absent from `.env.example`,
 * while apps/web's example listed it. `Sentry.init` is called unconditionally and silently
 * no-ops on an undefined dsn — there is no startup warning — so the API shipped with NO error
 * reporting and nothing distinguished that from a healthy service. A customer's credit could
 * fail and nobody would be told. `INTERNAL_API_SECRET`, `PAYOUT_ENCRYPTION_KEY` and the whole
 * R2 and Airwallex credential sets were undocumented for the same reason: nothing checked.
 *
 * An undocumented variable is not a style problem — it is a variable nobody knows to set in a
 * new environment, and its absence usually degrades silently rather than failing loudly.
 */

/** Vitest may run from the package or the repo root, so resolve against both (CI does the latter). */
function apiRoot(): string {
  const candidates = [process.cwd(), join(process.cwd(), 'apps/api')];
  const found = candidates.find((c) => existsSync(join(c, '.env.example')));
  if (found === undefined) {
    throw new Error(`Could not locate apps/api/.env.example from ${process.cwd()}`);
  }
  return found;
}

/** Strip comments so a variable merely NAMED in prose is not mistaken for a real read. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
}

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      collectTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Provided by the runtime, not by configuration — documenting them would be noise.
 * `TEST_DATABASE_URL` is injected by the integration harness.
 */
const RUNTIME_PROVIDED = new Set(['NODE_ENV', 'TZ', 'TEST_DATABASE_URL']);

describe('.env.example documents every env var the API reads', () => {
  it('has no undocumented production reads', () => {
    const root = apiRoot();

    const documented = new Set(
      [...readFileSync(join(root, '.env.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
        (m) => m[1] as string
      )
    );

    const read = new Set<string>();
    for (const file of collectTsFiles(join(root, 'src'))) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        const name = m[1] as string;
        if (!RUNTIME_PROVIDED.has(name)) read.add(name);
      }
    }

    const undocumented = [...read].filter((name) => !documented.has(name)).sort();

    // Named in the failure so a new variable tells you exactly what to add and where.
    expect(undocumented, `Add these to apps/api/.env.example: ${undocumented.join(', ')}`).toEqual(
      []
    );
  });

  it('documents the observability vars whose absence is silent', () => {
    // Singled out because these three fail OPEN: unset, the app runs normally and simply
    // reports nothing, which is indistinguishable from healthy.
    const example = readFileSync(join(apiRoot(), '.env.example'), 'utf8');
    for (const name of ['SENTRY_DSN', 'AXIOM_TOKEN', 'AXIOM_DATASET']) {
      expect(example).toMatch(new RegExp(`^${name}=`, 'm'));
    }
  });
});
