import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockFindByCompanyId } = vi.hoisted(() => ({ mockFindByCompanyId: vi.fn() }));
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findByCompanyId: (...a: unknown[]) => mockFindByCompanyId(...a) },
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

const mockLoggedFetch = vi.fn();
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...a: unknown[]) => mockLoggedFetch(...a),
}));

import { startContinueToMandate } from './start-continue-to-mandate';

const USER = { id: 'user-1', companyId: 'company-1', companyName: 'Northwind Industrial' };
const PENDING_WALLET = { id: 'wallet-1', mandateStatus: 'pending' };

const PREV_ENV = {
  pk: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  secret: process.env.INTERNAL_API_SECRET,
  apiUrl: process.env.API_URL,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_abc';
  process.env.INTERNAL_API_SECRET = 'internal-secret';
  process.env.API_URL = 'http://api.test';
  mockRequireUser.mockResolvedValue(USER);
  mockHasCapability.mockResolvedValue(true);
  mockFindByCompanyId.mockResolvedValue(PENDING_WALLET);
  mockLoggedFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ clientSecret: 'seti_123_secret', setupIntentId: 'seti_123' }),
  });
});

afterAll(() => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PREV_ENV.pk;
  process.env.INTERNAL_API_SECRET = PREV_ENV.secret;
  process.env.API_URL = PREV_ENV.apiUrl;
});

describe('startContinueToMandate', () => {
  it('returns forbidden for an unauthenticated caller', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await startContinueToMandate()).toEqual({ status: 'forbidden' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('returns forbidden when the caller lacks MANAGE_BILLING', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect(await startContinueToMandate()).toEqual({ status: 'forbidden' });
    expect(mockFindByCompanyId).not.toHaveBeenCalled();
  });

  it('returns unconfigured when the publishable key is missing', async () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    expect(await startContinueToMandate()).toEqual({ status: 'unconfigured' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('returns error when the company has no wallet', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);
    expect(await startContinueToMandate()).toEqual({ status: 'error' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('short-circuits to already_active when the mandate is active (no setup intent)', async () => {
    mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1', mandateStatus: 'active' });
    expect(await startContinueToMandate()).toEqual({ status: 'already_active' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('returns ready with the client secret + publishable key, calling the internal seam', async () => {
    const result = await startContinueToMandate();
    expect(result).toEqual({
      status: 'ready',
      clientSecret: 'seti_123_secret',
      publishableKey: 'pk_test_abc',
    });
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      'http://api.test/stripe/setup-intent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-api-key': 'internal-secret' }),
        body: JSON.stringify({ walletId: 'wallet-1' }),
      })
    );
  });

  it('returns error when the internal seam responds non-ok', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect(await startContinueToMandate()).toEqual({ status: 'error' });
  });

  it('returns error when the seam returns no clientSecret', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    expect(await startContinueToMandate()).toEqual({ status: 'error' });
  });
});
