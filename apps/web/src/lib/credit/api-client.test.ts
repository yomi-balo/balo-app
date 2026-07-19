import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockLoggedFetch = vi.fn();
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createPurchaseIntent, createMandateSetupIntent, CreditApiError } from './api-client';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('credit api-client', () => {
  const originalSecret = process.env.INTERNAL_API_SECRET;
  const originalApiUrl = process.env.API_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_SECRET = 'secret-123';
    process.env.API_URL = 'http://api.test';
  });
  afterEach(() => {
    process.env.INTERNAL_API_SECRET = originalSecret;
    process.env.API_URL = originalApiUrl;
  });

  it('POSTs the purchase-intent with the internal secret header and returns the client secret', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ clientSecret: 'pi_secret', paymentIntentId: 'pi_1' })
    );

    const result = await createPurchaseIntent({
      walletId: 'wallet-1',
      presentmentCurrency: 'aud',
      presentmentAmountMinor: 100_000,
      initiatingMemberId: 'user-1',
      clientRequestId: 'req-1',
      promoCode: 'WELCOME50',
    });

    expect(result).toEqual({ clientSecret: 'pi_secret', paymentIntentId: 'pi_1' });
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      'http://api.test/credit/purchase-intent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-api-key': 'secret-123' }),
      })
    );
  });

  it('creates a mandate setup-intent', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ clientSecret: 'seti_secret', setupIntentId: 'seti_1', customerId: 'cus_1' })
    );
    const result = await createMandateSetupIntent('wallet-1');
    expect(result.clientSecret).toBe('seti_secret');
  });

  it('throws CreditApiError on a non-2xx response', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'wallet_not_found' }, false, 404));
    await expect(createMandateSetupIntent('wallet-x')).rejects.toBeInstanceOf(CreditApiError);
  });

  it('throws when the internal secret is missing', async () => {
    delete process.env.INTERNAL_API_SECRET;
    await expect(createMandateSetupIntent('wallet-1')).rejects.toBeInstanceOf(CreditApiError);
  });
});
