import { describe, expect, it } from 'vitest';
import { ALL_SOURCE_FILES, codeLines, readRaw } from './_source-scan.js';

/**
 * INVARIANT — `services/daily/webhook-subscription` is imported by the ops script only.
 *
 * Registering or rotating the Daily webhook is a per-environment ops step (daily-co SKILL.md);
 * application code must never create or modify a subscription. The script lives under
 * `apps/api/scripts/`, outside `src`, so any importer inside `src` is a violation.
 *
 * No regex over source text (S5852): a plain substring scan over non-comment lines.
 */
const MODULE = 'webhook-subscription';
const OWN_FILE = 'services/daily/webhook-subscription.ts';

function importsSubscription(source: string): boolean {
  return codeLines(source)
    .split('\n')
    .some((line) => line.includes(MODULE) && (line.includes('import') || line.includes('from')));
}

describe('the Daily webhook subscription module is script-only', () => {
  it('is imported by no non-test file under apps/api/src', () => {
    const offenders = ALL_SOURCE_FILES.filter(
      (rel) => rel !== OWN_FILE && importsSubscription(readRaw(rel))
    );
    expect(offenders).toEqual([]);
  });

  it('scans a real source surface that includes the module itself', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(100);
    expect(ALL_SOURCE_FILES).toContain(OWN_FILE);
  });

  it('positive control — importsSubscription flags an import and ignores comments and other modules', () => {
    expect(importsSubscription("import { x } from './webhook-subscription.js';")).toBe(true);
    expect(importsSubscription("const m = await import('./webhook-subscription.js');")).toBe(true);
    expect(importsSubscription("// import { x } from './webhook-subscription.js';")).toBe(false);
    expect(importsSubscription("import { x } from './webhook-signature.js';")).toBe(false);
  });
});
