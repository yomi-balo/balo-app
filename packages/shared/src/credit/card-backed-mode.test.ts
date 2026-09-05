import { describe, it, expect } from 'vitest';
import {
  isCardBackedLowBalanceMode,
  CARD_BACKED_LOW_BALANCE_MODES,
  type CardBackedLowBalanceMode,
} from './settlement';

/**
 * BAL-524 — `isCardBackedLowBalanceMode` / `CARD_BACKED_LOW_BALANCE_MODES`, the ONE definition
 * of "which low-balance mode needs a card". Small and table-driven, mirroring
 * `card-reuse.test.ts`'s posture.
 *
 * FIX ROUND (F9) — this file previously carried TWO redundant cases and one tautological one:
 *   · a standalone "every member of CARD_BACKED_LOW_BALANCE_MODES satisfies the predicate, and
 *     notify_only does not" case was a strict SUBSET of the `it.each` below (same three values,
 *     same three assertions) — folded in by DERIVING the `it.each` table from
 *     `CARD_BACKED_LOW_BALANCE_MODES` itself, so it now covers both claims as one.
 *   · an "is NOT the same question as `isWalletCardReusableOnSession`" pin compared two DIFFERENT
 *     inputs (a mode string vs. a wallet object) fed to functions with incompatible argument
 *     types — no realistic mutation of either function could ever collapse that assertion, and
 *     TypeScript itself already forbids swapping one implementation for the other (the signatures
 *     don't unify). A test that cannot fail is not a pin; it is deleted rather than kept for
 *     show. The two predicates' independence is documented in `isCardBackedLowBalanceMode`'s own
 *     docblock instead of asserted here.
 */

const CASES = [
  ...CARD_BACKED_LOW_BALANCE_MODES.map((mode) => ({ mode, expected: true }) as const),
  { mode: 'notify_only', expected: false } as const,
];

describe('isCardBackedLowBalanceMode', () => {
  // Derived from CARD_BACKED_LOW_BALANCE_MODES (plus the one known non-member, notify_only) so
  // this table and "every member of the set satisfies the predicate" can never drift apart —
  // extending the set automatically extends the cases this exercises.
  it.each(CASES)('$mode → $expected', ({ mode, expected }) => {
    expect(isCardBackedLowBalanceMode(mode)).toBe(expected);
  });

  it('CARD_BACKED_LOW_BALANCE_MODES is exactly the D4 set — a future edit must change this consciously', () => {
    const expected: readonly CardBackedLowBalanceMode[] = ['auto_topup', 'keep_going'];
    expect(CARD_BACKED_LOW_BALANCE_MODES).toEqual(expected);
  });

  it('fails CLOSED on an unknown future mode string — never treated as card-backed by accident', () => {
    expect(isCardBackedLowBalanceMode('some_future_mode')).toBe(false);
  });
});
