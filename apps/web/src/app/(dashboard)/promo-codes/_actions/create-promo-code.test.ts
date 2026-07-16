import { describe, it, expect, vi, beforeEach } from 'vitest';

const PROMO_ID = 'b0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

// Error classes must be the SAME objects the action imports so `instanceof` holds; the
// repo is a mock. The authz seam is REAL (pure `@balo/shared/authz` map) so the new
// MANAGE_PROMO_CODES capability gate is exercised end-to-end.
const { mockCreate, DuplicatePromoCodeError } = vi.hoisted(() => {
  class DuplicatePromoCodeError extends Error {
    constructor(public readonly code: string) {
      super(`dup ${code}`);
      this.name = 'DuplicatePromoCodeError';
    }
  }
  return { mockCreate: vi.fn(), DuplicatePromoCodeError };
});
vi.mock('@balo/db', () => ({
  promoCodesRepository: { create: (...a: unknown[]) => mockCreate(...a) },
  DuplicatePromoCodeError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  PROMO_SERVER_EVENTS: { PROMO_CODE_CREATED: 'promo_code_created' },
}));

import { createPromoCode } from './create-promo-code';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const VALID_INPUT = {
  code: 'welcome50',
  grantMinor: 5000,
  perCodeRedemptionCap: 100,
  validFrom: '2026-07-01T00:00:00.000Z',
  validUntil: '2026-08-01T00:00:00.000Z',
};
const CREATED = {
  id: PROMO_ID,
  code: 'WELCOME50',
  grantMinor: 5000,
  perCodeRedemptionCap: 100,
  redeemedCount: 0,
  validFrom: new Date('2026-07-01T00:00:00.000Z'),
  validUntil: new Date('2026-08-01T00:00:00.000Z'),
  status: 'active',
  createdBy: 'admin-1',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  deletedAt: null,
};

const PERMISSION_DENIED = 'You do not have permission to do this.';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockCreate.mockResolvedValue(CREATED);
});

describe('createPromoCode', () => {
  it('denies an unauthenticated caller before touching the repo (no existence leak)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await createPromoCode(VALID_INPUT);
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('denies a viewer without MANAGE_PROMO_CODES (plain user)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await createPromoCode(VALID_INPUT);
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed code before hitting the repo', async () => {
    const result = await createPromoCode({ ...VALID_INPUT, code: 'no' });
    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an inverted validity window', async () => {
    const result = await createPromoCode({
      ...VALID_INPUT,
      validFrom: '2026-08-01T00:00:00.000Z',
      validUntil: '2026-07-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-positive grant', async () => {
    const result = await createPromoCode({ ...VALID_INPUT, grantMinor: 0 });
    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates the code (repo normalizes), emits analytics + log.info, and revalidates', async () => {
    const result = await createPromoCode(VALID_INPUT);

    expect(mockCreate).toHaveBeenCalledWith({
      code: 'welcome50', // repo normalizes to uppercase — the action passes the trimmed value
      grantMinor: 5000,
      perCodeRedemptionCap: 100,
      validFrom: new Date('2026-07-01T00:00:00.000Z'),
      validUntil: new Date('2026-08-01T00:00:00.000Z'),
      createdBy: 'admin-1',
    });
    expect(mockTrack).toHaveBeenCalledWith('promo_code_created', {
      promo_code_id: PROMO_ID,
      grant_minor: 5000,
      per_code_redemption_cap: 100,
      valid_from: '2026-07-01T00:00:00.000Z',
      valid_until: '2026-08-01T00:00:00.000Z',
      distinct_id: 'admin-1',
    });
    expect(log.info).toHaveBeenCalledWith(
      'Admin minted promo code',
      expect.objectContaining({ promoCodeId: PROMO_ID, actorUserId: 'admin-1' })
    );
    expect(revalidatePath).toHaveBeenCalledWith('/promo-codes');
    expect(result).toEqual({ success: true, promoCodeId: PROMO_ID, code: 'WELCOME50' });
  });

  it('allows a super_admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'sa-1', platformRole: 'super_admin' });
    const result = await createPromoCode(VALID_INPUT);
    expect(result).toEqual({ success: true, promoCodeId: PROMO_ID, code: 'WELCOME50' });
  });

  it('maps a duplicate code to a friendly field message (no analytics, no error log)', async () => {
    mockCreate.mockRejectedValue(new DuplicatePromoCodeError('WELCOME50'));
    const result = await createPromoCode(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'A code with that name already exists.',
      field: 'code',
    });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('maps an unexpected repo throw to the generic error and logs it', async () => {
    mockCreate.mockRejectedValue(new Error('DB down'));
    const result = await createPromoCode(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not create the promo code. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to create promo code',
      expect.objectContaining({ error: 'DB down', actorUserId: 'admin-1' })
    );
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
