import { describe, expect, it } from 'vitest';
import { scanWorkspaceSources, type ScannedFile } from './_source-scan';

/**
 * BAL-591 decision 12 — structural invariant: opening a NEW case has exactly one production
 * writer, `book-consultation.ts`.
 *
 * Pausing new work blocks only the opening of a new case; a follow-up on an ALREADY-OPEN case is
 * allowed. That split lives inside `book-consultation.ts`, where the 'new' arm is gated on new-work
 * eligibility and the attach-to-open-case arm is not. A second caller of
 * `caseEngagementsRepository.create` would open a case with no such gate and let a paused expert
 * take new work, so no other production module may call it.
 *
 * Seed code and test fixtures (`.test.` files are skipped by the scan) are the only other callers
 * and are excluded by path.
 */

const WRITER_REL = 'apps/web/src/lib/booking/actions/book-consultation.ts';
const CREATE_MARKER = 'caseEngagementsRepository.create(';
const EXCLUDED_PATH_PARTS = ['/services/seed/', '/test/fixtures/', '/test/factories/'] as const;

function isExcluded(rel: string): boolean {
  return EXCLUDED_PATH_PARTS.some((part) => rel.includes(part));
}

function createCallers(files: readonly ScannedFile[]): string[] {
  return files
    .filter((file) => !isExcluded(file.rel) && file.code.includes(CREATE_MARKER))
    .map((file) => file.rel);
}

describe('invariant: a new case has exactly one writer (BAL-591 decision 12)', () => {
  const all = scanWorkspaceSources();

  it('scans both workspace trees (guards against a vacuous pass)', () => {
    expect(all.length).toBeGreaterThan(500);
    expect(all.some((file) => file.rel.startsWith('apps/api/'))).toBe(true);
    expect(all.some((file) => file.rel.startsWith('packages/db/'))).toBe(true);
  });

  it('book-consultation.ts is the only production caller of caseEngagementsRepository.create', () => {
    expect(createCallers(all)).toEqual([WRITER_REL]);
  });

  it('the seed service is the excluded caller, so the exclusion is not dead', () => {
    const seed = all.filter((file) => file.rel.includes('/services/seed/'));
    expect(seed.some((file) => file.code.includes(CREATE_MARKER))).toBe(true);
  });

  it('⚠ guards the guard: a second production caller would be caught', () => {
    const decoy: ScannedFile = {
      rel: 'apps/web/src/lib/booking/actions/decoy.ts',
      code: 'await caseEngagementsRepository.create({});',
      raw: '',
    };
    expect(createCallers([...all, decoy])).toEqual([WRITER_REL, decoy.rel]);
  });
});
