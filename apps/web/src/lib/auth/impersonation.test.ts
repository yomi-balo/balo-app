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
  markSessionAsImpersonated,
  analyticsIdentityFor,
} from './impersonation';
import type { SessionUser } from './session';

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

  it('refuses and warns exactly once under an impersonated session, naming the impersonator', () => {
    const result = refuseMoneyActionUnderImpersonation(
      { isImpersonating: true, impersonatorUserId: 'admin-1' },
      { action: 'removeSavedCardAction', companyId: 'company-1', actorUserId: 'user-1' }
    );

    expect(result).toBe(true);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(IMPERSONATION_REFUSAL_MESSAGE, {
      action: 'removeSavedCardAction',
      companyId: 'company-1',
      actorUserId: 'user-1',
      impersonatorUserId: 'admin-1',
    });
  });

  it('permits and stays SILENT for a normal session', () => {
    const result = refuseMoneyActionUnderImpersonation(
      { isImpersonating: false, impersonatorUserId: undefined },
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

describe('markSessionAsImpersonated (BAL-553)', () => {
  const baseUser: SessionUser = {
    id: 'target-1',
    email: 'target@example.com',
    firstName: 'Target',
    lastName: 'User',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Target Co',
    companyRole: 'owner',
  };

  it('sets isImpersonating, impersonatorUserId and impersonationExpiresAt', () => {
    const marked = markSessionAsImpersonated(baseUser, {
      impersonatorUserId: 'admin-1',
      expiresAt: 1_700_000_000_000,
    });

    expect(marked.isImpersonating).toBe(true);
    expect(marked.impersonatorUserId).toBe('admin-1');
    expect(marked.impersonationExpiresAt).toBe(1_700_000_000_000);
  });

  it('does not mutate the input user', () => {
    const marked = markSessionAsImpersonated(baseUser, {
      impersonatorUserId: 'admin-1',
      expiresAt: 1_700_000_000_000,
    });

    expect(baseUser.isImpersonating).toBeUndefined();
    expect(marked).not.toBe(baseUser);
  });

  it('preserves every other field of the input user unchanged', () => {
    const marked = markSessionAsImpersonated(baseUser, {
      impersonatorUserId: 'admin-1',
      expiresAt: 1_700_000_000_000,
    });

    expect(marked.id).toBe(baseUser.id);
    expect(marked.email).toBe(baseUser.email);
    expect(marked.companyId).toBe(baseUser.companyId);
    expect(marked.platformRole).toBe(baseUser.platformRole);
  });
});

describe('analyticsIdentityFor (BAL-553)', () => {
  it('returns undefined under an impersonated session', () => {
    expect(analyticsIdentityFor({ isImpersonating: true, id: 'target-1' })).toBeUndefined();
  });

  it('returns the user id for a normal session', () => {
    expect(analyticsIdentityFor({ isImpersonating: false, id: 'user-1' })).toBe('user-1');
  });

  it('returns the user id when isImpersonating is undefined (every pre-existing session)', () => {
    expect(analyticsIdentityFor({ isImpersonating: undefined, id: 'user-1' })).toBe('user-1');
  });
});
