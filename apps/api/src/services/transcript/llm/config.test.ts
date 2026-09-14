import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_TRANSCRIPT_MODEL, resolveCleanupModel, resolveSummaryModel } from './config.js';

/**
 * ⚠⚠ BAL-254 **RULING B, PINNED** (fix round F8). This file exists for ONE reason: before it,
 * adding an `allowList` to either resolver below would have broken ZERO tests. Ruling B —
 * "transcript keeps PERMISSIVE model resolution; the allow-list introduced for the project-brief
 * parser applies to that consumer ONLY" — was an unenforced comment, and the thing it protects
 * (a `TRANSCRIPT_CLEANUP_MODEL` / `TRANSCRIPT_SUMMARY_MODEL` value already set on a deployed
 * Railway service) fails in PRODUCTION, not in CI, when someone "tidies" it.
 *
 * MUTATION-PROVED: adding `allowList: ['claude-sonnet-5']` to `resolveCleanupModel` turns the
 * first test below red, and reverting turns it green again.
 *
 * IF THIS TEST FAILS: someone has bounded transcript's model resolution. That is a deliberate,
 * env-audited change (every deployed `TRANSCRIPT_*_MODEL` override has to be checked against the
 * new list first) — never a drive-by fix for a failing test. See the plan's D8 / Ruling B.
 */

const CLEANUP_ENV = 'TRANSCRIPT_CLEANUP_MODEL';
const SUMMARY_ENV = 'TRANSCRIPT_SUMMARY_MODEL';

/** A model id that is in NO allow-list anywhere in this codebase, by construction. */
const UNLISTED_MODEL = 'unlisted-model';

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

const originalCleanup = process.env[CLEANUP_ENV];
const originalSummary = process.env[SUMMARY_ENV];

afterEach(() => {
  setEnv(CLEANUP_ENV, originalCleanup);
  setEnv(SUMMARY_ENV, originalSummary);
});

describe('transcript model resolution stays PERMISSIVE (Ruling B)', () => {
  it('resolveCleanupModel passes an arbitrary, unlisted override straight through', () => {
    setEnv(CLEANUP_ENV, UNLISTED_MODEL);
    expect(resolveCleanupModel()).toBe(UNLISTED_MODEL);
  });

  it('resolveSummaryModel passes an arbitrary, unlisted override straight through', () => {
    setEnv(SUMMARY_ENV, UNLISTED_MODEL);
    expect(resolveSummaryModel()).toBe(UNLISTED_MODEL);
  });

  it('an absent override falls back to the default', () => {
    setEnv(CLEANUP_ENV, undefined);
    setEnv(SUMMARY_ENV, undefined);
    expect(resolveCleanupModel()).toBe(DEFAULT_TRANSCRIPT_MODEL);
    expect(resolveSummaryModel()).toBe(DEFAULT_TRANSCRIPT_MODEL);
  });

  it('an EMPTY override is treated as absent, matching how .env.example ships every override', () => {
    setEnv(CLEANUP_ENV, '');
    setEnv(SUMMARY_ENV, '');
    expect(resolveCleanupModel()).toBe(DEFAULT_TRANSCRIPT_MODEL);
    expect(resolveSummaryModel()).toBe(DEFAULT_TRANSCRIPT_MODEL);
  });

  it('the env var names are read at the CALL SITE as literals (D8 — env-example-coverage relies on it)', () => {
    // Not a behavioural assertion: a restatement of why the two tests above are written against
    // `process.env` rather than a parameter. `env-example-coverage.test.ts` regex-matches the
    // literal `process.env.NAME`, so a resolver that read the name dynamically would silently
    // stop being covered by that guard.
    expect(DEFAULT_TRANSCRIPT_MODEL).toBe('claude-sonnet-5');
  });
});
