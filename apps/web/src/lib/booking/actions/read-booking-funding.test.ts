import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingFundingResult } from '../booking-funding-gate';

const mockRequireOnboardedUser = vi.fn();
const mockAssessBookingFunding = vi.fn();
const mockEnforceBookingFunding = vi.fn();
const mockResolveFundingSubject = vi.fn();
const mockFindByCompanyId = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockPublishNotificationEvent = vi.fn();
const mockTrackServerAndFlush = vi.fn();
const mockTrack = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));
vi.mock('@balo/db', () => ({
  creditWalletsRepository: {
    findByCompanyId: (...args: unknown[]) => mockFindByCompanyId(...args),
  },
}));
vi.mock('@/lib/logging', () => ({
  log: {
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    info: vi.fn(),
  },
}));
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublishNotificationEvent(...args),
}));
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
}));
vi.mock('@/lib/analytics', () => ({ track: (...args: unknown[]) => mockTrack(...args) }));
vi.mock('../booking-funding-gate', () => ({
  assessBookingFunding: (...args: unknown[]) => mockAssessBookingFunding(...args),
  enforceBookingFunding: (...args: unknown[]) => mockEnforceBookingFunding(...args),
}));
vi.mock('../resolve-funding-subject', () => ({
  resolveFundingSubject: (...args: unknown[]) => mockResolveFundingSubject(...args),
}));

import { readBookingFundingAction } from './read-booking-funding';
import type { BookingFundingRequest } from './booking-funding-types';

const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
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

const COMPANY = { id: COMPANY_ID, name: 'Northwind Industrial', isActive: true };

type Refusal = Exclude<BookingFundingResult, { ok: true } | { reason: 'unavailable' }>;

function unfunded(overrides: Partial<Refusal> = {}): BookingFundingResult {
  return {
    ok: false,
    reason: 'unfunded',
    canManageBilling: true,
    billingCompany: COMPANY,
    suggestedTopUpMinor: 30_000,
    setupKind: 'no_wallet',
    ...overrides,
  } as BookingFundingResult;
}

const HOLD: BookingFundingResult = {
  ok: false,
  reason: 'on_hold',
  canManageBilling: true,
  billingCompany: COMPANY,
  suggestedTopUpMinor: 40_000,
  topUpNeededMinor: 27_500,
};

const RESERVED: BookingFundingResult = {
  ok: false,
  reason: 'reserved',
  canManageBilling: false,
  billingCompany: COMPANY,
  suggestedTopUpMinor: 30_000,
  topUpNeededMinor: 7_500,
  reservedBookingCount: 2,
};

const WALLET_ROW = {
  lowBalanceMode: 'notify_only',
  topupReloadMinor: 10_000,
  topupThresholdMinor: 2_000,
  cardBrand: 'visa',
  cardLast4: '4242',
  cardExpMonth: 8,
  cardExpYear: 2028,
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
  mandateStatus: 'active',
  expiresAt: new Date('2027-02-01T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockResolveFundingSubject.mockResolvedValue({
    ok: true,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockAssessBookingFunding.mockResolvedValue({ ok: true });
  mockFindByCompanyId.mockResolvedValue(WALLET_ROW);
});

describe('readBookingFundingAction', () => {
  it('authenticates via requireOnboardedUser', async () => {
    await readBookingFundingAction(REQUEST);
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed input as unavailable, before resolving anything', async () => {
    const result = await readBookingFundingAction({ ...REQUEST, expertProfileId: 'nope' });

    expect(result).toEqual({ kind: 'unavailable' });
    expect(mockResolveFundingSubject).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking funding pre-flight failed validation',
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('rejects a slot whose window disagrees with its duration', async () => {
    const result = await readBookingFundingAction({
      ...REQUEST,
      slot: { ...REQUEST.slot, durationMinutes: 60 },
    });
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('a passing verdict is clear', async () => {
    expect(await readBookingFundingAction(REQUEST)).toEqual({ kind: 'clear' });
  });

  it('an unresolvable subject is unavailable and never reaches the gate', async () => {
    mockResolveFundingSubject.mockResolvedValue({ ok: false });

    expect(await readBookingFundingAction(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(mockAssessBookingFunding).not.toHaveBeenCalled();
  });

  it('an unavailable verdict is unavailable', async () => {
    mockAssessBookingFunding.mockResolvedValue({ ok: false, reason: 'unavailable' });
    expect(await readBookingFundingAction(REQUEST)).toEqual({ kind: 'unavailable' });
  });

  it('feeds the gate the resolved subject, the session company and the covered-hold mode', async () => {
    await readBookingFundingAction({ ...REQUEST, onCoveredHold: 'refuse' });

    expect(mockAssessBookingFunding).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      slot: { startIso: REQUEST.slot.startIso, endIso: REQUEST.slot.endIso },
      activeCompanyId: COMPANY_ID,
      onCoveredHold: 'refuse',
    });
  });

  it("defaults the covered-hold mode to 'defer'", async () => {
    await readBookingFundingAction(REQUEST);
    expect(mockAssessBookingFunding).toHaveBeenCalledWith(
      expect.objectContaining({ onCoveredHold: 'defer' })
    );
  });

  it('a throw is logged and returns unavailable', async () => {
    mockAssessBookingFunding.mockRejectedValue(new Error('boom'));

    expect(await readBookingFundingAction(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Booking funding pre-flight failed',
      expect.objectContaining({ userId: 'user-1', error: 'boom' })
    );
  });

  it('a wallet read failure is unavailable, not a half-built view', async () => {
    mockAssessBookingFunding.mockResolvedValue(HOLD);
    mockFindByCompanyId.mockRejectedValue(new Error('db down'));

    expect(await readBookingFundingAction(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  describe('nothing is told to anybody (AC2)', () => {
    it.each([
      ['unfunded', unfunded()],
      ['on_hold', HOLD],
      ['reserved', RESERVED],
    ])('a %s refusal publishes, tracks and enforces nothing', async (_label, refusal) => {
      mockAssessBookingFunding.mockResolvedValue(refusal);

      await readBookingFundingAction(REQUEST);

      expect(mockPublishNotificationEvent).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
      expect(mockTrack).not.toHaveBeenCalled();
      expect(mockEnforceBookingFunding).not.toHaveBeenCalled();
    });
  });

  describe('the refused view', () => {
    it('setup arm for a manager of the active company: wallet projected, first time, no figure', async () => {
      mockAssessBookingFunding.mockResolvedValue(unfunded());
      mockFindByCompanyId.mockResolvedValue(undefined);

      const view = await readBookingFundingAction(REQUEST);

      expect(view).toEqual({
        kind: 'refused',
        arm: 'setup',
        canManageBilling: true,
        company: COMPANY,
        firstTime: true,
        topUpNeededMinor: null,
        reservedBookingCount: null,
        suggestedTopUpMinor: 30_000,
        wallet: { savedCard: null },
      });
      expect(mockFindByCompanyId).toHaveBeenCalledWith(COMPANY_ID);
    });

    it('a setup arm with a short wallet that has held credit is NOT first time', async () => {
      mockAssessBookingFunding.mockResolvedValue(
        unfunded({ setupKind: 'no_mandate_insufficient_balance' } as Partial<Refusal>)
      );

      const view = await readBookingFundingAction(REQUEST);

      expect(view).toMatchObject({ kind: 'refused', arm: 'setup', firstTime: false });
    });

    it('a wallet row that never held credit is first time', async () => {
      mockAssessBookingFunding.mockResolvedValue(
        unfunded({ setupKind: 'no_mandate_insufficient_balance' } as Partial<Refusal>)
      );
      mockFindByCompanyId.mockResolvedValue({ ...WALLET_ROW, expiresAt: null });

      expect(await readBookingFundingAction(REQUEST)).toMatchObject({ firstTime: true });
    });

    it('hold arm: carries the figure and the saved card, no reserved count', async () => {
      mockAssessBookingFunding.mockResolvedValue(HOLD);

      const view = await readBookingFundingAction(REQUEST);

      expect(view).toMatchObject({
        kind: 'refused',
        arm: 'hold',
        topUpNeededMinor: 27_500,
        reservedBookingCount: null,
        suggestedTopUpMinor: 40_000,
        wallet: {
          savedCard: {
            brand: 'visa',
            last4: '4242',
            expMonth: 8,
            expYear: 2028,
            mandateActive: true,
          },
        },
      });
    });

    it('a failed-heal hold keeps its null figure', async () => {
      mockAssessBookingFunding.mockResolvedValue({ ...HOLD, topUpNeededMinor: null });

      expect(await readBookingFundingAction(REQUEST)).toMatchObject({
        arm: 'hold',
        topUpNeededMinor: null,
      });
    });

    it('reserved arm for a MEMBER: count carried, wallet and its read skipped', async () => {
      mockAssessBookingFunding.mockResolvedValue(RESERVED);

      const view = await readBookingFundingAction(REQUEST);

      expect(view).toMatchObject({
        kind: 'refused',
        arm: 'reserved',
        canManageBilling: false,
        topUpNeededMinor: 7_500,
        reservedBookingCount: 2,
        wallet: null,
        firstTime: false,
      });
      expect(mockFindByCompanyId).not.toHaveBeenCalled();
    });

    it('a member never receives the suggested top-up; a billing manager does', async () => {
      mockAssessBookingFunding.mockResolvedValue(RESERVED);
      expect(await readBookingFundingAction(REQUEST)).toMatchObject({
        canManageBilling: false,
        suggestedTopUpMinor: null,
      });

      mockAssessBookingFunding.mockResolvedValue(HOLD);
      expect(await readBookingFundingAction(REQUEST)).toMatchObject({
        canManageBilling: true,
        suggestedTopUpMinor: 40_000,
      });

      mockAssessBookingFunding.mockResolvedValue(unfunded({ canManageBilling: false }));
      expect(await readBookingFundingAction(REQUEST)).toMatchObject({ suggestedTopUpMinor: null });
    });

    it('a manager of a NON-active company gets no wallet read either', async () => {
      mockAssessBookingFunding.mockResolvedValue({
        ...HOLD,
        billingCompany: { ...COMPANY, isActive: false },
      });

      const view = await readBookingFundingAction(REQUEST);

      expect(view).toMatchObject({ kind: 'refused', wallet: null });
      expect(mockFindByCompanyId).not.toHaveBeenCalled();
    });

    it('a member on a no-wallet setup arm is still first time without any read', async () => {
      mockAssessBookingFunding.mockResolvedValue(unfunded({ canManageBilling: false }));

      expect(await readBookingFundingAction(REQUEST)).toMatchObject({
        wallet: null,
        firstTime: true,
      });
      expect(mockFindByCompanyId).not.toHaveBeenCalled();
    });

    it('AC11 — the view has EXACTLY these keys on every arm: no rate, estimate, available or reserved figure', async () => {
      const expectedKeys = [
        'arm',
        'canManageBilling',
        'company',
        'firstTime',
        'kind',
        'reservedBookingCount',
        'suggestedTopUpMinor',
        'topUpNeededMinor',
        'wallet',
      ];
      for (const refusal of [unfunded(), HOLD, RESERVED]) {
        mockAssessBookingFunding.mockResolvedValue(refusal);
        const view = await readBookingFundingAction(REQUEST);
        expect(Object.keys(view).sort((a, b) => a.localeCompare(b))).toEqual(expectedKeys);
      }
    });
  });
});
