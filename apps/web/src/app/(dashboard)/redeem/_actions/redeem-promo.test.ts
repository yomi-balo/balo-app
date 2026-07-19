import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRedeem } = vi.hoisted(() => ({ mockRedeem: vi.fn() }));
vi.mock('@balo/db', () => ({
  promoCodesRepository: { redeem: (...a: unknown[]) => mockRedeem(...a) },
  // The real normalizer is a pure trim+uppercase — mirror it so `code` is asserted.
  normalizePromoCode: (raw: string) => raw.trim().toUpperCase(),
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { MANAGE_BILLING: 'MANAGE_BILLING' },
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  PROMO_SERVER_EVENTS: {
    PROMO_REDEEMED: 'promo_redeemed',
    PROMO_CODE_REDEEMED_VS_CAP: 'promo_code_redeemed_vs_cap',
  },
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

import { redeemPromoCode } from './redeem-promo';
import { log } from '@/lib/logging';

const USER = { id: 'user-1', companyId: 'company-1', companyName: 'Northwind Industrial' };

const REDEEMED = {
  outcome: 'redeemed' as const,
  redemption: { id: 'redemption-1', promoCodeId: 'promo-1' },
  grantedMinor: 5000,
  balanceAfterMinor: 5000,
  redeemedCount: 3,
  perCodeRedemptionCap: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue(USER);
  mockHasCapability.mockResolvedValue(true);
  mockRedeem.mockResolvedValue(REDEEMED);
});

describe('redeemPromoCode', () => {
  it('returns forbidden (and never touches the repo) for an unauthenticated caller', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await redeemPromoCode({ code: 'WELCOME50' });
    expect(result).toEqual({ status: 'forbidden' });
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('returns forbidden when the caller lacks MANAGE_BILLING (no existence leak)', async () => {
    mockHasCapability.mockResolvedValue(false);
    const result = await redeemPromoCode({ code: 'WELCOME50' });
    expect(result).toEqual({ status: 'forbidden' });
    expect(mockHasCapability).toHaveBeenCalledWith(USER, 'MANAGE_BILLING', {
      companyId: 'company-1',
    });
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('rejects an empty code before hitting the repo', async () => {
    const result = await redeemPromoCode({ code: '   ' });
    expect(result).toEqual({ status: 'not_found' });
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('redeems: maps labels, publishes promo.redeemed, and emits both server events', async () => {
    const result = await redeemPromoCode({ code: 'welcome50' });

    expect(result).toEqual({
      status: 'redeemed',
      grantedLabel: 'A$50.00',
      balanceLabel: 'A$50.00',
      alreadyRedeemed: false,
    });
    expect(mockRedeem).toHaveBeenCalledWith({
      rawCode: 'welcome50',
      companyId: 'company-1',
      redeemedByUserId: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('promo.redeemed', {
      correlationId: 'redemption-1',
      userId: 'user-1',
      code: 'WELCOME50',
      grantedLabel: 'A$50.00',
      companyName: 'Northwind Industrial',
    });
    expect(mockTrack).toHaveBeenCalledWith('promo_redeemed', {
      promo_code_id: 'promo-1',
      granted_minor: 5000,
      distinct_id: 'user-1',
    });
    expect(mockTrack).toHaveBeenCalledWith('promo_code_redeemed_vs_cap', {
      promo_code_id: 'promo-1',
      redeemed_count: 3,
      per_code_redemption_cap: 10,
      utilisation_pct: 30,
      distinct_id: 'user-1',
    });
    expect(log.info).toHaveBeenCalledWith(
      'Promo code redeemed',
      expect.objectContaining({
        promoCodeId: 'promo-1',
        companyId: 'company-1',
      })
    );
  });

  it('logs and swallows a notification publish failure — the redeem still succeeds', async () => {
    mockPublish.mockRejectedValueOnce(new Error('queue down'));
    const result = await redeemPromoCode({ code: 'WELCOME50' });
    // Credit already landed → the redeem outcome is unaffected by the publish failure.
    expect(result).toEqual({
      status: 'redeemed',
      grantedLabel: 'A$50.00',
      balanceLabel: 'A$50.00',
      alreadyRedeemed: false,
    });
    // The `.catch` runs as a microtask after the action returns — wait for it.
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith(
        'promo.redeemed notification publish failed',
        expect.objectContaining({ error: 'queue down', correlationId: 'redemption-1' })
      )
    );
  });

  it('already_redeemed: maps to redeemed with no balance, and does NOT publish or track', async () => {
    mockRedeem.mockResolvedValue({
      outcome: 'already_redeemed',
      redemption: { id: 'redemption-1', promoCodeId: 'promo-1' },
      grantedMinor: 5000,
    });
    const result = await redeemPromoCode({ code: 'WELCOME50' });
    expect(result).toEqual({
      status: 'redeemed',
      grantedLabel: 'A$50.00',
      balanceLabel: null,
      alreadyRedeemed: true,
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', { outcome: 'not_found' }],
    ['scheduled', { outcome: 'scheduled', validFrom: new Date() }],
    ['expired', { outcome: 'expired', validUntil: new Date() }],
    ['deactivated', { outcome: 'deactivated' }],
    ['exhausted', { outcome: 'exhausted' }],
  ])('maps the %s refusal to a warm status (no publish, no track)', async (status, outcome) => {
    mockRedeem.mockResolvedValue(outcome);
    const result = await redeemPromoCode({ code: 'WELCOME50' });
    expect(result).toEqual({ status });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('maps an unexpected repo throw to the error status and logs it', async () => {
    mockRedeem.mockRejectedValue(new Error('DB down'));
    const result = await redeemPromoCode({ code: 'WELCOME50' });
    expect(result).toEqual({ status: 'error' });
    expect(log.error).toHaveBeenCalledWith(
      'Promo redeem failed',
      expect.objectContaining({ error: 'DB down', companyId: 'company-1' })
    );
  });
});
