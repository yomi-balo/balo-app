import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockReadSnapshot,
  mockAssess,
  mockHealCoveredHoldNow,
  mockCaptureException,
  mockLogInfo,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockReadSnapshot: vi.fn(),
  mockAssess: vi.fn(),
  mockHealCoveredHoldNow: vi.fn(),
  mockCaptureException: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  }),
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
vi.mock('@balo/db', () => ({ bookingFundingRepository: { readSnapshot: mockReadSnapshot } }));
vi.mock('@balo/shared/credit', () => ({ assessCaseBookingFunding: mockAssess }));
vi.mock('../credit-session/notify.js', () => ({ healCoveredHoldNow: mockHealCoveredHoldNow }));

import { checkCaseBookingFunding } from './case-booking-funding.js';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const START = new Date('2026-09-26T10:00:00.000Z');
const END = new Date('2026-09-26T10:30:00.000Z');
const INPUT = {
  companyId: 'company-1',
  expertProfileId: 'expert-1',
  scheduledStart: START,
  scheduledEnd: END,
  now: NOW,
} as const;
const SNAPSHOT = { kind: 'no_mandate', walletId: 'wallet-1' };
const COVERED = { ok: false, reason: 'covered_hold', walletId: 'wallet-1' };

describe('checkCaseBookingFunding (BAL-474, ADR-1040 Amendment 7 §H, D6.1 / D6.5 / D8.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSnapshot.mockResolvedValue(SNAPSHOT);
    mockAssess.mockReturnValue({ ok: true, arm: 'balance' });
    mockHealCoveredHoldNow.mockResolvedValue({ healed: true });
  });

  it('reads ONE snapshot for the company and expert and runs ONE pure verdict over the booking window', async () => {
    await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({ ok: true });
    expect(mockReadSnapshot).toHaveBeenCalledTimes(1);
    expect(mockReadSnapshot).toHaveBeenCalledWith({
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      now: NOW,
    });
    expect(mockAssess).toHaveBeenCalledWith(SNAPSHOT, { scheduledStart: START, scheduledEnd: END });
  });

  it.each([
    ['a mandate', { ok: true, arm: 'mandate' }],
    ['a missing expert rate (not the client’s refusal)', { ok: true, arm: 'rate_missing' }],
    ['a sufficient balance', { ok: true, arm: 'balance' }],
  ])('%s passes', async (_label, verdict) => {
    mockAssess.mockReturnValue(verdict);
    await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({ ok: true });
    expect(mockHealCoveredHoldNow).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'account_on_hold', hold: {} }, 'account_on_hold'],
    [{ ok: false, reason: 'reserved_by_upcoming' }, 'booking_reserved'],
    [{ ok: false, reason: 'no_wallet' }, 'booking_unfunded'],
    [{ ok: false, reason: 'no_mandate_insufficient_balance' }, 'booking_unfunded'],
  ])('maps the verdict %j onto %s', async (verdict, code) => {
    mockAssess.mockReturnValue(verdict);
    await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({ ok: false, code });
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ code }),
      expect.stringContaining('refused before any write')
    );
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('⚠ unknown_expert is unreachable (the expert is the gate’s own engagement row) — and when reached it fails CLOSED and logs at ERROR, not info', async () => {
    mockAssess.mockReturnValue({ ok: false, reason: 'unknown_expert' });
    await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({
      ok: false,
      code: 'booking_funding_unavailable',
    });
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        expertProfileId: 'expert-1',
        reason: 'unknown_expert',
      }),
      expect.stringContaining('unknown expert')
    );
    expect(mockLogInfo).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('refused before any write')
    );
  });

  describe('the refusal log carries the verdict’s FIGURES (so a web/API disagreement can be diagnosed)', () => {
    it.each([
      [
        'reserved_by_upcoming',
        {
          ok: false,
          reason: 'reserved_by_upcoming',
          estimateMinor: 1_000,
          availableMinor: 2_000,
          reservedMinor: 3_000,
          reservedBookingCount: 2,
          topUpNeededMinor: 2_000,
        },
        {
          estimateMinor: 1_000,
          availableMinor: 2_000,
          reservedMinor: 3_000,
          reservedBookingCount: 2,
          topUpNeededMinor: 2_000,
        },
      ],
      [
        'no_mandate_insufficient_balance',
        {
          ok: false,
          reason: 'no_mandate_insufficient_balance',
          estimateMinor: 900,
          availableMinor: 100,
        },
        { estimateMinor: 900, availableMinor: 100 },
      ],
      [
        'account_on_hold',
        { ok: false, reason: 'account_on_hold', hold: { amountToClearMinor: 4_200 } },
        { amountToClearMinor: 4_200 },
      ],
    ])('%s', async (_reason, verdict, figures) => {
      mockAssess.mockReturnValue(verdict);
      await checkCaseBookingFunding(INPUT);
      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: 'company-1',
          expertProfileId: 'expert-1',
          ...figures,
        }),
        expect.stringContaining('refused before any write')
      );
    });
  });

  describe('D8.1 — a covered hold is HEALED, never shown', () => {
    it('heals under the wallet lock, re-reads ONE fresh snapshot, and passes when the re-run passes', async () => {
      mockAssess.mockReturnValueOnce(COVERED).mockReturnValueOnce({ ok: true, arm: 'balance' });

      await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({ ok: true });

      expect(mockHealCoveredHoldNow).toHaveBeenCalledTimes(1);
      expect(mockHealCoveredHoldNow).toHaveBeenCalledWith({
        walletId: 'wallet-1',
        trigger: 'booking_guard',
        now: NOW,
      });
      expect(mockReadSnapshot).toHaveBeenCalledTimes(2);
      expect(mockAssess).toHaveBeenCalledTimes(2);
    });

    it('the re-run can still refuse for another reason (a reservation) — the heal never waives the rest of the verdict', async () => {
      mockAssess
        .mockReturnValueOnce(COVERED)
        .mockReturnValueOnce({ ok: false, reason: 'reserved_by_upcoming' });
      await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({
        ok: false,
        code: 'booking_reserved',
      });
    });

    it('a SECOND covered_hold after a successful heal is treated as an open hold — the heal runs ONCE, never in a loop', async () => {
      mockAssess.mockReturnValue(COVERED);
      await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({
        ok: false,
        code: 'account_on_hold',
      });
      expect(mockHealCoveredHoldNow).toHaveBeenCalledTimes(1);
      expect(mockReadSnapshot).toHaveBeenCalledTimes(2);
    });

    it('a heal that reports nothing healed (another writer cleared it first) still re-runs the verdict once', async () => {
      mockHealCoveredHoldNow.mockResolvedValue({ healed: false });
      mockAssess.mockReturnValueOnce(COVERED).mockReturnValueOnce({ ok: true, arm: 'balance' });
      await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({ ok: true });
      expect(mockReadSnapshot).toHaveBeenCalledTimes(2);
    });

    it('⚠ a heal that THROWS is warned + captured, and the answer is account_on_hold — the hold is still open, so the brake applies', async () => {
      const failure = new Error('lock timeout');
      mockHealCoveredHoldNow.mockRejectedValue(failure);
      mockAssess.mockReturnValue(COVERED);

      await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({
        ok: false,
        code: 'account_on_hold',
      });

      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 'wallet-1', error: 'lock timeout' }),
        expect.stringContaining('could not heal a covered hold')
      );
      expect(mockCaptureException).toHaveBeenCalledWith(failure, {
        extra: { walletId: 'wallet-1', op: 'booking_guard_heal' },
      });
      // No re-read after a failed heal.
      expect(mockReadSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  describe('fails CLOSED', () => {
    it('an unreadable snapshot is booking_funding_unavailable, logged at error with the stack', async () => {
      mockReadSnapshot.mockRejectedValue(new Error('db down'));
      await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({
        ok: false,
        code: 'booking_funding_unavailable',
      });
      expect(mockLogError).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-1', error: 'db down' }),
        expect.stringContaining('failing CLOSED')
      );
    });

    it('a failed RE-read after a successful heal fails closed too', async () => {
      mockAssess.mockReturnValueOnce(COVERED);
      mockReadSnapshot.mockResolvedValueOnce(SNAPSHOT).mockRejectedValueOnce(new Error('db down'));
      await expect(checkCaseBookingFunding(INPUT)).resolves.toEqual({
        ok: false,
        code: 'booking_funding_unavailable',
      });
    });
  });
});
