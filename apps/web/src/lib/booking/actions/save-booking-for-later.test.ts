import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireOnboardedUser = vi.fn();
const mockEnforceBookingFunding = vi.fn();
const mockAssessBookingFunding = vi.fn();
const mockResolveFundingSubject = vi.fn();
const mockIsImpersonatedSession = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));
vi.mock('@/lib/auth/impersonation', () => ({
  isImpersonatedSession: (...args: unknown[]) => mockIsImpersonatedSession(...args),
}));
vi.mock('@/lib/logging', () => ({
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));
vi.mock('../booking-funding-gate', () => ({
  assessBookingFunding: (...args: unknown[]) => mockAssessBookingFunding(...args),
  enforceBookingFunding: (...args: unknown[]) => mockEnforceBookingFunding(...args),
}));
vi.mock('../resolve-funding-subject', () => ({
  resolveFundingSubject: (...args: unknown[]) => mockResolveFundingSubject(...args),
}));

import { saveBookingForLaterAction } from './save-booking-for-later';
import type { BookingFundingRequest } from './booking-funding-types';

const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const ROW_EXPERT_ID = '99999999-9999-4999-8999-999999999999';
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'user-1', onboardingCompleted: true, companyId: COMPANY_ID };

const REQUEST: BookingFundingRequest = {
  expertProfileId: EXPERT_PROFILE_ID,
  slot: {
    startIso: '2026-09-22T10:00:00.000Z',
    endIso: '2026-09-22T10:30:00.000Z',
    durationMinutes: 30,
  },
  caseChoice: { kind: 'new' },
};

const REFUSAL = {
  ok: false,
  reason: 'reserved',
  canManageBilling: false,
  billingCompany: { id: COMPANY_ID, name: 'Northwind', isActive: true },
  suggestedTopUpMinor: 30_000,
  topUpNeededMinor: 7_500,
  reservedBookingCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockIsImpersonatedSession.mockReturnValue(false);
  mockResolveFundingSubject.mockResolvedValue({
    ok: true,
    companyId: COMPANY_ID,
    expertProfileId: ROW_EXPERT_ID,
  });
  mockAssessBookingFunding.mockResolvedValue(REFUSAL);
  mockEnforceBookingFunding.mockResolvedValue(REFUSAL);
});

describe('saveBookingForLaterAction', () => {
  it('authenticates via requireOnboardedUser', async () => {
    await saveBookingForLaterAction(REQUEST);
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('a still-refused member: enforces ONCE, deferring a covered hold, and reports ok', async () => {
    const result = await saveBookingForLaterAction(REQUEST);

    expect(result).toEqual({ ok: true });
    expect(mockEnforceBookingFunding).toHaveBeenCalledTimes(1);
    expect(mockEnforceBookingFunding).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      companyId: COMPANY_ID,
      expertProfileId: ROW_EXPERT_ID,
      slot: { startIso: REQUEST.slot.startIso, endIso: REQUEST.slot.endIso },
      activeCompanyId: COMPANY_ID,
      onCoveredHold: 'defer',
    });
    expect(mockLogInfo).toHaveBeenCalledWith('Booking saved for later — billing admins notified', {
      userId: 'user-1',
      companyId: COMPANY_ID,
      expertProfileId: ROW_EXPERT_ID,
    });
  });

  it('funded by now: not_refused, nothing logged as saved', async () => {
    mockAssessBookingFunding.mockResolvedValue({ ok: true });

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'not_refused' });
    expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('a billing manager who is refused is not_refused (they top up, they do not save)', async () => {
    mockAssessBookingFunding.mockResolvedValue({ ...REFUSAL, canManageBilling: true });

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'not_refused' });
    // The real gate publishes and tracks only inside enforce, which a manager never reaches.
    expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('follows the second read when it comes back funded', async () => {
    mockEnforceBookingFunding.mockResolvedValue({ ok: true });

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'not_refused' });
  });

  it('follows the second read when the actor is now a billing manager', async () => {
    mockEnforceBookingFunding.mockResolvedValue({ ...REFUSAL, canManageBilling: true });

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'not_refused' });
  });

  it('an unreadable pre-check fails and never reaches the publishing gate', async () => {
    mockAssessBookingFunding.mockResolvedValue({ ok: false, reason: 'unavailable' });

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'failed' });
    expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      'Save booking for later — funding state unavailable',
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('an unavailable funding state on the second read fails and is logged', async () => {
    mockEnforceBookingFunding.mockResolvedValue({ ok: false, reason: 'unavailable' });

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'failed' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Save booking for later — funding state unavailable',
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('a thrown error fails and is logged', async () => {
    mockEnforceBookingFunding.mockRejectedValue(new Error('boom'));

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'failed' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Save booking for later failed',
      expect.objectContaining({ error: 'boom' })
    );
  });

  it('an unresolvable subject fails without reaching the gate', async () => {
    mockResolveFundingSubject.mockResolvedValue({ ok: false });

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'failed' });
    expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
  });

  it('an impersonated session is refused before anything resolves or publishes', async () => {
    mockIsImpersonatedSession.mockReturnValue(true);

    expect(await saveBookingForLaterAction(REQUEST)).toEqual({ ok: false, reason: 'refused' });
    expect(mockResolveFundingSubject).not.toHaveBeenCalled();
    expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
  });

  it('rejects malformed input before resolving anything', async () => {
    const result = await saveBookingForLaterAction({ ...REQUEST, expertProfileId: 'nope' });

    expect(result).toEqual({ ok: false, reason: 'failed' });
    expect(mockResolveFundingSubject).not.toHaveBeenCalled();
  });
});
