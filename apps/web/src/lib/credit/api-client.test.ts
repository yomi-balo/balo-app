import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockLoggedFetch = vi.fn();
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// `callSessionApi` resolves the actor SERVER-SIDE from the iron-session — mock it to a valid,
// onboarded principal so every session-hop test exercises the transport branches (not the auth gate).
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(async () => ({
    user: { id: 'u1', onboardingCompleted: true },
    accessToken: 'tok',
  })),
}));

import {
  createPurchaseIntent,
  createMandateSetupIntent,
  callSessionApi,
  CreditApiError,
} from './api-client';

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

describe('callSessionApi (BAL-401 companies-parsing branches)', () => {
  const originalApiUrl = process.env.API_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_URL = 'http://api.test';
  });
  afterEach(() => {
    process.env.API_URL = originalApiUrl;
  });

  it('parses the eligible companies off a company_selection_required failure body', async () => {
    const companies = [
      { id: 'c1', name: 'Acme', logoUrl: null },
      { id: 'c2', name: 'Globex', logoUrl: 'https://logo/globex.png' },
    ];
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ code: 'company_selection_required', companies }, false, 409)
    );

    const result = await callSessionApi('/sessions', 'POST', {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('company_selection_required');
    expect(result.companies).toEqual(companies);
  });

  it('omits companies when the failure body carries none', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ code: 'insufficient_no_mandate' }, false, 409)
    );

    const result = await callSessionApi('/sessions', 'POST', {});

    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('insufficient_no_mandate');
    expect(result).not.toHaveProperty('companies');
  });

  it('treats a non-array companies field as absent', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ code: 'company_selection_required', companies: 'nope' }, false, 409)
    );

    const result = await callSessionApi('/sessions', 'POST', {});

    if (result.ok) throw new Error('expected failure');
    expect(result).not.toHaveProperty('companies');
  });

  it('drops malformed items and defaults a bad/absent logoUrl to null', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse(
        {
          code: 'company_selection_required',
          companies: [
            null,
            'string',
            { id: 5, name: 'BadId' },
            { id: 'c9', name: 42 },
            { id: 'c1', name: 'Acme' }, // absent logoUrl → null
            { id: 'c2', name: 'Globex', logoUrl: 7 }, // non-string logoUrl → null
          ],
        },
        false,
        409
      )
    );

    const result = await callSessionApi('/sessions', 'POST', {});

    if (result.ok) throw new Error('expected failure');
    expect(result.companies).toEqual([
      { id: 'c1', name: 'Acme', logoUrl: null },
      { id: 'c2', name: 'Globex', logoUrl: null },
    ]);
  });

  it('returns a success result with the parsed body on a 2xx', async () => {
    const body = { sessionId: 's1', status: 'pending', holdId: null };
    mockLoggedFetch.mockResolvedValue(jsonResponse(body, true, 201));

    const result = await callSessionApi('/sessions', 'POST', {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data).toEqual(body);
  });
});
