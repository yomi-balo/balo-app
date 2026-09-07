import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockLogWarn = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: (...a: unknown[]) => mockLogWarn(...a),
    debug: vi.fn(),
  },
}));

import {
  isImpersonatedSession,
  refuseMoneyActionUnderImpersonation,
  IMPERSONATION_REFUSAL_MESSAGE,
} from './impersonation';

describe('isImpersonatedSession — true ONLY for the literal boolean true', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['isImpersonating: true', true, true],
    ['isImpersonating: false', false, false],
    [
      'isImpersonating: undefined — every session sealed before this feature exists',
      undefined,
      false,
    ],
    // A truthy-but-NOT-`true` value. `===` reports false here; `Boolean(...)` (truthiness) would
    // wrongly report true — this is what actually distinguishes the two implementations.
    ['isImpersonating: {} (truthy, but not the literal true)', {} as unknown as boolean, false],
  ])('%s → %s', (_label, isImpersonating, expected) => {
    expect(isImpersonatedSession({ isImpersonating })).toBe(expected);
  });
});

describe('refuseMoneyActionUnderImpersonation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses and warns exactly once under an impersonated session', () => {
    const result = refuseMoneyActionUnderImpersonation(
      { isImpersonating: true },
      { action: 'removeSavedCardAction', companyId: 'company-1', actorUserId: 'user-1' }
    );

    expect(result).toBe(true);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(IMPERSONATION_REFUSAL_MESSAGE, {
      action: 'removeSavedCardAction',
      companyId: 'company-1',
      actorUserId: 'user-1',
    });
  });

  it('permits and stays SILENT for a normal session', () => {
    const result = refuseMoneyActionUnderImpersonation(
      { isImpersonating: false },
      { action: 'removeSavedCardAction', companyId: 'company-1', actorUserId: 'user-1' }
    );

    expect(result).toBe(false);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('the refusal message is the exported constant, verbatim', () => {
    expect(IMPERSONATION_REFUSAL_MESSAGE).toBe(
      'Destructive money action refused — impersonated session'
    );
  });
});
