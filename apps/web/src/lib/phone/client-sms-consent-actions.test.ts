import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// `@/lib/logging` is auto-mocked globally in src/test/setup.ts.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);
vi.mock('server-only', () => ({}));

const mockFind = vi.fn();
const mockSet = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findClientSmsConsent: (...args: unknown[]) => mockFind(...args),
    setClientSmsConsent: (...args: unknown[]) => mockSet(...args),
  },
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import {
  getClientSmsConsentStateAction,
  setClientSmsConsentAction,
} from './client-sms-consent-actions';

const VERIFIED_AT = new Date('2026-01-01T00:00:00Z');
const OPTED_IN_AT = new Date('2026-02-01T00:00:00Z');

function sessionFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { user: { id: 'user-1', onboardingCompleted: true, ...overrides } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionObj = sessionFor();
});

describe('getClientSmsConsentStateAction', () => {
  it('reports opted_in only when consent, verification and a number are all set', async () => {
    mockFind.mockResolvedValue({
      phone: '+61406431059',
      phoneVerifiedAt: VERIFIED_AT,
      clientSmsOptedInAt: OPTED_IN_AT,
    });
    await expect(getClientSmsConsentStateAction()).resolves.toEqual({
      status: 'opted_in',
      phone: '+61406431059',
    });
    expect(mockFind).toHaveBeenCalledWith('user-1');
  });

  it('offers the verified number when consent is missing (the expert case)', async () => {
    mockFind.mockResolvedValue({
      phone: '+61406431059',
      phoneVerifiedAt: VERIFIED_AT,
      clientSmsOptedInAt: null,
    });
    await expect(getClientSmsConsentStateAction()).resolves.toEqual({
      status: 'not_opted_in',
      verifiedPhone: '+61406431059',
    });
  });

  it('is not opted in when consent is set but the number is unverified', async () => {
    mockFind.mockResolvedValue({
      phone: '+61406431059',
      phoneVerifiedAt: null,
      clientSmsOptedInAt: OPTED_IN_AT,
    });
    await expect(getClientSmsConsentStateAction()).resolves.toEqual({
      status: 'not_opted_in',
      verifiedPhone: null,
    });
  });

  it('is not opted in when consent is set but there is no number', async () => {
    mockFind.mockResolvedValue({
      phone: null,
      phoneVerifiedAt: VERIFIED_AT,
      clientSmsOptedInAt: OPTED_IN_AT,
    });
    await expect(getClientSmsConsentStateAction()).resolves.toEqual({
      status: 'not_opted_in',
      verifiedPhone: null,
    });
  });

  it('is unavailable when the user row is missing', async () => {
    mockFind.mockResolvedValue(undefined);
    await expect(getClientSmsConsentStateAction()).resolves.toEqual({ status: 'unavailable' });
  });

  it('is unavailable for an impersonated session, without reading the repository', async () => {
    mockSessionObj = sessionFor({ isImpersonating: true, impersonatorUserId: 'staff-1' });
    await expect(getClientSmsConsentStateAction()).resolves.toEqual({ status: 'unavailable' });
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('logs and returns unavailable when the repository throws', async () => {
    mockFind.mockRejectedValue(new Error('db down'));
    await expect(getClientSmsConsentStateAction()).resolves.toEqual({ status: 'unavailable' });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to read client SMS consent',
      expect.objectContaining({ userId: 'user-1', error: 'db down' })
    );
  });

  it('rejects an unauthenticated caller', async () => {
    mockSessionObj = {};
    await expect(getClientSmsConsentStateAction()).rejects.toThrow('Unauthorized');
  });
});

describe('setClientSmsConsentAction', () => {
  it('records consent and logs the change', async () => {
    mockSet.mockResolvedValue({ outcome: 'changed' });
    await expect(
      setClientSmsConsentAction({ optedIn: true, surface: 'booking_confirmation' })
    ).resolves.toEqual({ ok: true });
    expect(mockSet).toHaveBeenCalledWith({ userId: 'user-1', optedIn: true });
    expect(log.info).toHaveBeenCalledWith('Client SMS consent changed', {
      userId: 'user-1',
      optedIn: true,
      surface: 'booking_confirmation',
    });
  });

  it('removes consent', async () => {
    mockSet.mockResolvedValue({ outcome: 'changed' });
    await expect(
      setClientSmsConsentAction({ optedIn: false, surface: 'account_settings' })
    ).resolves.toEqual({ ok: true });
    expect(mockSet).toHaveBeenCalledWith({ userId: 'user-1', optedIn: false });
  });

  it('succeeds without logging a change when nothing changed', async () => {
    mockSet.mockResolvedValue({ outcome: 'unchanged' });
    await expect(
      setClientSmsConsentAction({ optedIn: true, surface: 'intro_call_confirmation' })
    ).resolves.toEqual({ ok: true });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('passes phone_not_verified through', async () => {
    mockSet.mockResolvedValue({ outcome: 'phone_not_verified' });
    await expect(
      setClientSmsConsentAction({ optedIn: true, surface: 'booking_confirmation' })
    ).resolves.toEqual({ ok: false, code: 'phone_not_verified' });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('refuses an impersonated session without touching the repository', async () => {
    mockSessionObj = sessionFor({ isImpersonating: true, impersonatorUserId: 'staff-1' });
    await expect(
      setClientSmsConsentAction({ optedIn: true, surface: 'booking_confirmation' })
    ).resolves.toEqual({ ok: false, code: 'impersonation_refused' });
    expect(mockSet).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Client SMS consent change refused — impersonated session',
      expect.objectContaining({ userId: 'user-1', impersonatorUserId: 'staff-1' })
    );
  });

  it('rejects invalid input without touching the repository', async () => {
    const bad = { optedIn: 'yes', surface: 'nowhere' } as unknown as Parameters<
      typeof setClientSmsConsentAction
    >[0];
    await expect(setClientSmsConsentAction(bad)).resolves.toEqual({
      ok: false,
      code: 'request_failed',
    });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('logs and returns request_failed when the repository throws', async () => {
    mockSet.mockRejectedValue(new Error('user row not found'));
    await expect(
      setClientSmsConsentAction({ optedIn: true, surface: 'booking_confirmation' })
    ).resolves.toEqual({ ok: false, code: 'request_failed' });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to change client SMS consent',
      expect.objectContaining({ userId: 'user-1', error: 'user row not found' })
    );
  });
});
