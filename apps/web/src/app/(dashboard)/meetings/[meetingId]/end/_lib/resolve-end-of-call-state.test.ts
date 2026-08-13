import { describe, it, expect } from 'vitest';
import type { RecapContextType } from '@/lib/meetings/end-of-call-view-types';
import {
  RATEABLE_CONTEXTS,
  contextIsRateable,
  resolveEndOfCallRecapReadiness,
} from './resolve-end-of-call-state';

describe('resolveEndOfCallRecapReadiness — a TWO-way question, not the recap six-way one', () => {
  it("is 'ready' ONLY when the transcript status is exactly ready", () => {
    expect(resolveEndOfCallRecapReadiness('ready')).toBe('ready');
  });

  it("folds processing, failed AND null into 'processing'", () => {
    // ⚠ `null` — no transcript row at all — is the COMMON case today: BAL-387 shipped the
    // pipeline INERT, with no production enqueuer. `failed` folds in deliberately: the recap
    // page renders its own failure state, and this screen's only job is to decide whether to
    // promise the recap is on its way.
    expect(resolveEndOfCallRecapReadiness('processing')).toBe('processing');
    expect(resolveEndOfCallRecapReadiness('failed')).toBe('processing');
    expect(resolveEndOfCallRecapReadiness(null)).toBe('processing');
  });

  it('emits ONLY the two declared values, for every input', () => {
    // A dimension value nothing emits reads as a 100%-drop-off funnel step. Four of
    // `RecapState`'s six values have no producer here and must never appear.
    const inputs = ['ready', 'processing', 'failed', null] as const;
    const emitted = new Set(inputs.map((input) => resolveEndOfCallRecapReadiness(input)));
    expect([...emitted].sort((a, b) => a.localeCompare(b))).toEqual(['processing', 'ready']);
  });
});

describe('RATEABLE_CONTEXTS — decided by the WRITE path, not by taste', () => {
  it('contains exactly case and project_kickoff', () => {
    // `applyReview`'s `reviewableKind` accepts `project` and `case` and REFUSES
    // `package` / `retainer`, so `package_session` / `retainer_checkin` would ALWAYS fail —
    // and `project_discovery` / `request_interaction` are REQUEST-grain, so their `context_id`
    // is not an engagement id at all.
    expect([...RATEABLE_CONTEXTS].sort((a, b) => a.localeCompare(b))).toEqual([
      'case',
      'project_kickoff',
    ]);
  });

  it('refuses every other context type', () => {
    const NOT_RATEABLE: readonly RecapContextType[] = [
      'project_discovery',
      'package_session',
      'retainer_checkin',
      'request_interaction',
    ];
    for (const contextType of NOT_RATEABLE) {
      expect(contextIsRateable(contextType), contextType + ' must not be rateable').toBe(false);
    }
  });

  it('accepts the two that are', () => {
    expect(contextIsRateable('case')).toBe(true);
    expect(contextIsRateable('project_kickoff')).toBe(true);
  });
});
