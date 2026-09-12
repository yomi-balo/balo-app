import { describe, it, expect } from 'vitest';
import { decisionOutcomeIsStale } from './decision-staleness';

/**
 * WEB-REVIEW FIX ROUND W3. The table IS the ruling: only the two codes that mean "the server's
 * truth moved while this page was open" refresh. MUTATION-PROVEN: widen the predicate to
 * `code !== undefined` and the `'denied'` row goes red; narrow it to `'not_pending'` only and the
 * `'gone'` row goes red.
 */
describe('decisionOutcomeIsStale', () => {
  it.each([
    ['not_pending', true],
    ['gone', true],
    ['denied', false],
  ] as const)('%s ⇒ %s', (code, expected) => {
    expect(decisionOutcomeIsStale(code)).toBe(expected);
  });

  it('a codeless failure (validation, or the generic catch) is not stale', () => {
    expect(decisionOutcomeIsStale(undefined)).toBe(false);
  });
});
