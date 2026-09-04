import { describe, it, expect } from 'vitest';
import { isAbsentPaymentMethodId } from './settlement';

/**
 * BAL-524 (R4, external review) — `isAbsentPaymentMethodId`, moved here from
 * `packages/db/src/repositories/credit-wallets.ts` (FIX ROUND F5) so it is ONE definition shared
 * by the Server Action guard (`apps/web/src/lib/credit/actions.ts`'s `saveLowBalanceConfigAction`)
 * and the repository write guard (`credit-wallets.ts`'s `updateConfig`). Table-driven, mirroring
 * `card-backed-mode.test.ts`'s posture.
 */
const CASES = [
  { label: 'null — the documented explicit clear', value: null, expected: true },
  {
    label: "'' — defence-in-depth, unreachable today but must still read as absent",
    value: '',
    expected: true,
  },
  {
    label: 'undefined — "not mentioned", NOT the same claim as absent',
    value: undefined,
    expected: false,
  },
  { label: 'a real Stripe payment-method id', value: 'pm_123', expected: false },
] as const;

describe('isAbsentPaymentMethodId', () => {
  it.each(CASES)('$label → $expected', ({ value, expected }) => {
    expect(isAbsentPaymentMethodId(value)).toBe(expected);
  });
});
