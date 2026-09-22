import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));

// Only the network hop is doubled. `isExpiredCredentialFailure` stays REAL — the expired-vs-refused
// split is exactly what these tests pin, so a stand-in would test nothing.
const mockPost = vi.fn();
vi.mock('@/lib/api/balo-api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/balo-api-client')>();
  return {
    ...actual,
    postBaloApiJsonWithFailureDetail: (...args: unknown[]) => mockPost(...args),
  };
});

import { AccountNotLiveError, ACCOUNT_UNREADABLE } from '@/lib/auth/account-liveness';
import { log } from '@/lib/logging';
import { sendPhoneOtpAction, verifyPhoneOtpAction } from './actions';

const PHONE = '+61412345678';

/** What `postBaloApiJsonWithFailureDetail` resolves with on a non-2xx. */
function apiFailure(status: number, code: string, detail?: number): unknown {
  return { ok: false, status, code, detail };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: 'user-1' });
});

describe('sendPhoneOtpAction', () => {
  it('posts the E.164 number to /phone/send-otp and reports success', async () => {
    mockPost.mockResolvedValue({ ok: true, data: {} });

    await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({ ok: true });

    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
    const [path, body, , parseFailure, label] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe('/phone/send-otp');
    expect(body).toEqual({ phone: PHONE });
    expect(label).toBe('phone-send-otp');
    // The failure reader takes the cooldown and nothing it cannot trust.
    expect(
      (parseFailure as (b: Record<string, unknown>) => unknown)({ cooldownSeconds: 540 })
    ).toBe(540);
    expect(
      (parseFailure as (b: Record<string, unknown>) => unknown)({ cooldownSeconds: '9' })
    ).toBe(undefined);
  });

  it('refuses without an onboarded user and never reaches the api', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));

    await expect(sendPhoneOtpAction(PHONE)).rejects.toThrow('Onboarding not completed');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects a non-E.164 number without calling the api', async () => {
    await expect(sendPhoneOtpAction('0412345678')).resolves.toEqual({
      ok: false,
      code: 'invalid_phone',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('carries the cooldown on a rate limit', async () => {
    mockPost.mockResolvedValue(apiFailure(429, 'rate_limited', 540));

    await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
      cooldownSeconds: 540,
    });
  });

  it('⚠ reports a dead credential as session_expired, not as a failed send', async () => {
    mockPost.mockResolvedValue(apiFailure(401, 'unauthorized'));

    await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({
      ok: false,
      code: 'session_expired',
    });
  });

  it('⚠ reports an account refusal as account_refused, never as session_expired', async () => {
    mockPost.mockResolvedValue(apiFailure(401, 'account_suspended'));
    await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({
      ok: false,
      code: 'account_refused',
    });

    mockPost.mockResolvedValue(apiFailure(401, 'account_deleted'));
    await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({
      ok: false,
      code: 'account_refused',
    });
  });

  it('passes the api literals it knows through unchanged', async () => {
    for (const code of ['invalid_phone', 'landline_not_supported', 'brevo_rejected'] as const) {
      mockPost.mockResolvedValue(apiFailure(code === 'brevo_rejected' ? 502 : 400, code));
      await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({ ok: false, code });
    }
  });

  it('maps a transport failure or an unknown literal to request_failed', async () => {
    mockPost.mockResolvedValue(apiFailure(0, 'request_failed'));
    await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({ ok: false, code: 'request_failed' });

    mockPost.mockResolvedValue(apiFailure(500, 'Internal Server Error'));
    await expect(sendPhoneOtpAction(PHONE)).resolves.toEqual({ ok: false, code: 'request_failed' });
  });
});

describe('verifyPhoneOtpAction', () => {
  it('posts the number and code to /phone/verify-otp and reports success', async () => {
    mockPost.mockResolvedValue({ ok: true, data: {} });

    await expect(verifyPhoneOtpAction(PHONE, '123456')).resolves.toEqual({ ok: true });

    const [path, body, , parseFailure, label] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe('/phone/verify-otp');
    expect(body).toEqual({ phone: PHONE, code: '123456' });
    expect(label).toBe('phone-verify-otp');
    expect(
      (parseFailure as (b: Record<string, unknown>) => unknown)({ attemptsRemaining: 2 })
    ).toBe(2);
    expect(
      (parseFailure as (b: Record<string, unknown>) => unknown)({ attemptsRemaining: -1 })
    ).toBe(undefined);
  });

  it('refuses without an onboarded user and never reaches the api', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));

    await expect(verifyPhoneOtpAction(PHONE, '123456')).rejects.toThrow('Onboarding not completed');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('never spends an attempt on a malformed code or number', async () => {
    await expect(verifyPhoneOtpAction(PHONE, '12ab56')).resolves.toEqual({
      ok: false,
      code: 'wrong_code',
    });
    await expect(verifyPhoneOtpAction('not-a-number', '123456')).resolves.toEqual({
      ok: false,
      code: 'invalid_phone',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('carries attemptsRemaining on wrong_code and final_attempt only', async () => {
    mockPost.mockResolvedValue(apiFailure(400, 'wrong_code', 2));
    await expect(verifyPhoneOtpAction(PHONE, '123456')).resolves.toEqual({
      ok: false,
      code: 'wrong_code',
      attemptsRemaining: 2,
    });

    mockPost.mockResolvedValue(apiFailure(400, 'final_attempt', 1));
    await expect(verifyPhoneOtpAction(PHONE, '123456')).resolves.toEqual({
      ok: false,
      code: 'final_attempt',
      attemptsRemaining: 1,
    });

    mockPost.mockResolvedValue(apiFailure(400, 'locked_out', 0));
    await expect(verifyPhoneOtpAction(PHONE, '123456')).resolves.toEqual({
      ok: false,
      code: 'locked_out',
    });
  });

  it('⚠ reports a dead credential (401) as session_expired, never as a wrong code', async () => {
    mockPost.mockResolvedValue(apiFailure(401, 'unauthorized'));

    await expect(verifyPhoneOtpAction(PHONE, '123456')).resolves.toEqual({
      ok: false,
      code: 'session_expired',
    });
  });

  it('passes code_expired through and maps an unknown literal to request_failed', async () => {
    mockPost.mockResolvedValue(apiFailure(400, 'code_expired'));
    await expect(verifyPhoneOtpAction(PHONE, '123456')).resolves.toEqual({
      ok: false,
      code: 'code_expired',
    });

    mockPost.mockResolvedValue(apiFailure(400, 'invalid_input'));
    await expect(verifyPhoneOtpAction(PHONE, '123456')).resolves.toEqual({
      ok: false,
      code: 'request_failed',
    });
  });
});

describe('the actor gate (both actions)', () => {
  const actions = [
    ['send', () => sendPhoneOtpAction(PHONE)],
    ['verify', () => verifyPhoneOtpAction(PHONE, '123456')],
  ] as const;

  it.each(actions)(
    '⚠ %s: a suspended or deleted account is account_refused, and the api is never reached',
    async (_label, run) => {
      mockRequireOnboardedUser.mockRejectedValueOnce(new AccountNotLiveError('account_suspended'));
      await expect(run()).resolves.toEqual({ ok: false, code: 'account_refused' });

      mockRequireOnboardedUser.mockRejectedValueOnce(new AccountNotLiveError('account_deleted'));
      await expect(run()).resolves.toEqual({ ok: false, code: 'account_refused' });

      expect(mockPost).not.toHaveBeenCalled();
    }
  );

  it.each(actions)(
    '⚠ %s: an unreadable account row fails as request_failed — a DB fault never signs anyone out',
    async (_label, run) => {
      mockRequireOnboardedUser.mockRejectedValueOnce(new AccountNotLiveError(ACCOUNT_UNREADABLE));
      await expect(run()).resolves.toEqual({ ok: false, code: 'request_failed' });
      expect(mockPost).not.toHaveBeenCalled();
    }
  );

  it.each(actions)(
    '⚠ %s: an impersonated session is refused BEFORE the api hop, never as session_expired',
    async (_label, run) => {
      mockRequireOnboardedUser.mockResolvedValueOnce({
        id: 'user-1',
        isImpersonating: true,
        impersonatorUserId: 'staff-1',
      });
      await expect(run()).resolves.toEqual({ ok: false, code: 'impersonation_refused' });
      expect(mockPost).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        'Phone verification refused — impersonated session',
        expect.objectContaining({ userId: 'user-1', impersonatorUserId: 'staff-1' })
      );
    }
  );

  it.each(actions)('%s: any other gate failure rethrows unchanged', async (_label, run) => {
    mockRequireOnboardedUser.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(run()).rejects.toThrow('Unauthorized');
    expect(mockPost).not.toHaveBeenCalled();
  });
});
