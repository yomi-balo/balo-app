import { describe, it, expect, vi, beforeEach } from 'vitest';

const PROMO_ID = 'b0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { mockDeactivate, PromoCodeNotFoundError } = vi.hoisted(() => {
  class PromoCodeNotFoundError extends Error {
    constructor(public readonly id: string) {
      super(`not found ${id}`);
      this.name = 'PromoCodeNotFoundError';
    }
  }
  return { mockDeactivate: vi.fn(), PromoCodeNotFoundError };
});
vi.mock('@balo/db', () => ({
  promoCodesRepository: { deactivate: (...a: unknown[]) => mockDeactivate(...a) },
  PromoCodeNotFoundError,
}));

import { deactivatePromoCode } from './deactivate-promo-code';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const PERMISSION_DENIED = 'You do not have permission to do this.';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockDeactivate.mockResolvedValue({ id: PROMO_ID, status: 'deactivated' });
});

describe('deactivatePromoCode', () => {
  it('denies an unauthenticated caller before touching the repo', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await deactivatePromoCode({ id: PROMO_ID });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockDeactivate).not.toHaveBeenCalled();
  });

  it('denies a viewer without MANAGE_PROMO_CODES', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await deactivatePromoCode({ id: PROMO_ID });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockDeactivate).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id before hitting the repo', async () => {
    const result = await deactivatePromoCode({ id: 'nope' });
    expect(result).toEqual({ success: false, error: 'This code no longer exists.' });
    expect(mockDeactivate).not.toHaveBeenCalled();
  });

  it('deactivates, logs, and revalidates on success', async () => {
    const result = await deactivatePromoCode({ id: PROMO_ID });
    expect(mockDeactivate).toHaveBeenCalledWith(PROMO_ID);
    expect(log.info).toHaveBeenCalledWith(
      'Admin deactivated promo code',
      expect.objectContaining({ promoCodeId: PROMO_ID, actorUserId: 'admin-1' })
    );
    expect(revalidatePath).toHaveBeenCalledWith('/promo-codes');
    expect(result).toEqual({ success: true });
  });

  it('maps a not-found code to a friendly gone message (no error log)', async () => {
    mockDeactivate.mockRejectedValue(new PromoCodeNotFoundError(PROMO_ID));
    const result = await deactivatePromoCode({ id: PROMO_ID });
    expect(result).toEqual({ success: false, error: 'This code no longer exists.' });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('maps an unexpected repo throw to the generic error and logs it', async () => {
    mockDeactivate.mockRejectedValue(new Error('DB down'));
    const result = await deactivatePromoCode({ id: PROMO_ID });
    expect(result).toEqual({
      success: false,
      error: 'Could not deactivate the code. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to deactivate promo code',
      expect.objectContaining({ error: 'DB down', actorUserId: 'admin-1' })
    );
  });
});
