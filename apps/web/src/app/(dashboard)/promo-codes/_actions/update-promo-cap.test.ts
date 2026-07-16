import { describe, it, expect, vi, beforeEach } from 'vitest';

const PROMO_ID = 'b0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { mockUpdateCap, CapBelowRedeemedCountError, PromoCodeNotFoundError } = vi.hoisted(() => {
  class CapBelowRedeemedCountError extends Error {
    constructor(
      public readonly redeemedCount: number,
      public readonly attemptedCap: number
    ) {
      super(`cap ${attemptedCap} < redeemed ${redeemedCount}`);
      this.name = 'CapBelowRedeemedCountError';
    }
  }
  class PromoCodeNotFoundError extends Error {
    constructor(public readonly id: string) {
      super(`not found ${id}`);
      this.name = 'PromoCodeNotFoundError';
    }
  }
  return { mockUpdateCap: vi.fn(), CapBelowRedeemedCountError, PromoCodeNotFoundError };
});
vi.mock('@balo/db', () => ({
  promoCodesRepository: { updateCap: (...a: unknown[]) => mockUpdateCap(...a) },
  CapBelowRedeemedCountError,
  PromoCodeNotFoundError,
}));

import { updatePromoCap } from './update-promo-cap';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const PERMISSION_DENIED = 'You do not have permission to do this.';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockUpdateCap.mockResolvedValue({ id: PROMO_ID, perCodeRedemptionCap: 250 });
});

describe('updatePromoCap', () => {
  it('denies an unauthenticated caller before touching the repo', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await updatePromoCap({ id: PROMO_ID, newCap: 250 });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockUpdateCap).not.toHaveBeenCalled();
  });

  it('denies a viewer without MANAGE_PROMO_CODES', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await updatePromoCap({ id: PROMO_ID, newCap: 250 });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockUpdateCap).not.toHaveBeenCalled();
  });

  it('rejects a non-positive cap before hitting the repo', async () => {
    const result = await updatePromoCap({ id: PROMO_ID, newCap: 0 });
    expect(result.success).toBe(false);
    expect(mockUpdateCap).not.toHaveBeenCalled();
  });

  it('updates the cap, logs, and revalidates on success', async () => {
    const result = await updatePromoCap({ id: PROMO_ID, newCap: 250 });
    expect(mockUpdateCap).toHaveBeenCalledWith({ id: PROMO_ID, newCap: 250 });
    expect(log.info).toHaveBeenCalledWith(
      'Admin updated promo cap',
      expect.objectContaining({ promoCodeId: PROMO_ID, actorUserId: 'admin-1', newCap: 250 })
    );
    expect(revalidatePath).toHaveBeenCalledWith('/promo-codes');
    expect(result).toEqual({ success: true, newCap: 250 });
  });

  it('maps a cap-below-redeemed error to a friendly message with the redeemed count', async () => {
    mockUpdateCap.mockRejectedValue(new CapBelowRedeemedCountError(40, 30));
    const result = await updatePromoCap({ id: PROMO_ID, newCap: 30 });
    expect(result).toEqual({
      success: false,
      error: "Cap can't be lower than the 40 redemptions already made.",
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('maps a not-found code to a friendly gone message', async () => {
    mockUpdateCap.mockRejectedValue(new PromoCodeNotFoundError(PROMO_ID));
    const result = await updatePromoCap({ id: PROMO_ID, newCap: 250 });
    expect(result).toEqual({ success: false, error: 'This code no longer exists.' });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('maps an unexpected repo throw to the generic error and logs it', async () => {
    mockUpdateCap.mockRejectedValue(new Error('DB down'));
    const result = await updatePromoCap({ id: PROMO_ID, newCap: 250 });
    expect(result).toEqual({
      success: false,
      error: 'Could not update the cap. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to update promo cap',
      expect.objectContaining({ error: 'DB down', actorUserId: 'admin-1' })
    );
  });
});
