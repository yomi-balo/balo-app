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
  confirmSavedCardMandate,
  detachSavedCardPaymentMethod,
  setCompanyBillingEmail,
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

  const purchaseInput = {
    walletId: 'wallet-1',
    presentmentCurrency: 'aud',
    presentmentAmountMinor: 100_000,
    initiatingMemberId: 'user-1',
    clientRequestId: 'req-1',
    promoCode: 'WELCOME50',
    paymentMethodSource: 'new_card' as const,
  };

  it('POSTs the purchase-intent with the internal secret header and returns the outcome', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({
        outcome: 'needs_client_confirmation',
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_1',
      })
    );

    const result = await createPurchaseIntent(purchaseInput);

    expect(result).toEqual({
      outcome: 'needs_client_confirmation',
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
    });
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      'http://api.test/credit/purchase-intent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-api-key': 'secret-123' }),
      })
    );
  });

  it('forwards the payment-method source to the api', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ outcome: 'complete', paymentIntentId: 'pi_saved' })
    );

    await createPurchaseIntent({ ...purchaseInput, paymentMethodSource: 'saved_card' });

    const [, init] = mockLoggedFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ paymentMethodSource: 'saved_card' });
  });

  it('creates a mandate setup-intent for a NEW card, threading the actorUserId (BAL-522 D2)', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ clientSecret: 'seti_secret', setupIntentId: 'seti_1', customerId: 'cus_1' })
    );
    const result = await createMandateSetupIntent('wallet-1', 'user-1');
    expect(result.clientSecret).toBe('seti_secret');
    const [, init] = mockLoggedFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      walletId: 'wallet-1',
      actorUserId: 'user-1',
      paymentMethodSource: 'new_card',
    });
  });

  it('confirms a mandate against the STORED card on the same route, threading the actorUserId', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ status: 'succeeded', clientSecret: null }));

    const result = await confirmSavedCardMandate('wallet-1', 'req-1', 'user-1');

    expect(result).toEqual({ status: 'succeeded', clientSecret: null });
    const [url, init] = mockLoggedFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://api.test/credit/setup-intent');
    expect(JSON.parse(init.body)).toEqual({
      walletId: 'wallet-1',
      actorUserId: 'user-1',
      paymentMethodSource: 'saved_card',
      // Keys the SetupIntent's Stripe idempotency — inherits the composer's per-decline rotation.
      clientRequestId: 'req-1',
    });
  });

  it('throws CreditApiError on a non-2xx response', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'wallet_not_found' }, false, 404));
    await expect(createMandateSetupIntent('wallet-x', 'user-1')).rejects.toBeInstanceOf(
      CreditApiError
    );
  });

  it('CARRIES the parsed failure body so a decline is not flattened to a generic fault', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ outcome: 'declined', code: 'insufficient_funds' }, false, 402)
    );

    await expect(createPurchaseIntent(purchaseInput)).rejects.toMatchObject({
      status: 402,
      body: { outcome: 'declined', code: 'insufficient_funds' },
    });
  });

  it('carries a no_saved_card 400 body', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'no_saved_card' }, false, 400));

    await expect(createPurchaseIntent(purchaseInput)).rejects.toMatchObject({
      status: 400,
      body: { error: 'no_saved_card' },
    });
  });

  it('tolerates a non-JSON failure body (an error page must not mask the status)', async () => {
    mockLoggedFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => '<html>Bad Gateway</html>',
    } as unknown as Response);

    await expect(createPurchaseIntent(purchaseInput)).rejects.toMatchObject({
      status: 502,
      body: undefined,
    });
  });

  it('throws when the internal secret is missing', async () => {
    delete process.env.INTERNAL_API_SECRET;
    await expect(createMandateSetupIntent('wallet-1', 'user-1')).rejects.toBeInstanceOf(
      CreditApiError
    );
  });

  it('detaches the saved card, posting the secret header and the effective mode', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ removed: true, lowBalanceMode: 'notify_only', modeReconciled: true })
    );

    const result = await detachSavedCardPaymentMethod('wallet-1', 'user-1');

    expect(result).toEqual({ removed: true, lowBalanceMode: 'notify_only', modeReconciled: true });
    const [url, init] = mockLoggedFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://api.test/credit/payment-method/detach');
    expect(init.method).toBe('POST');
    expect(init.headers['x-internal-api-key']).toBe('secret-123');
    // FIX ROUND 3 (N2) — `actorUserId` rides the same hop as `walletId`, threaded from the
    // caller's already-session-resolved actor.
    expect(JSON.parse(init.body)).toEqual({ walletId: 'wallet-1', actorUserId: 'user-1' });
  });

  it('throws CreditApiError carrying the status on a non-2xx detach response', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'stripe_detach_failed' }, false, 502));

    await expect(detachSavedCardPaymentMethod('wallet-1', 'user-1')).rejects.toMatchObject({
      status: 502,
      body: { error: 'stripe_detach_failed' },
    });
  });

  it('setCompanyBillingEmail posts to /credit/billing-email with the internal header', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({
        status: 'updated',
        billingEmail: 'dana@northwind.test',
        setAt: '2026-08-10T00:00:00.000Z',
      })
    );

    const result = await setCompanyBillingEmail({
      companyId: 'company-1',
      actorUserId: 'user-1',
      billingEmail: 'dana@northwind.test',
    });

    expect(result).toEqual({
      status: 'updated',
      billingEmail: 'dana@northwind.test',
      setAt: '2026-08-10T00:00:00.000Z',
    });
    const [url, init] = mockLoggedFetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://api.test/credit/billing-email');
    expect(init.method).toBe('POST');
    expect(init.headers['x-internal-api-key']).toBe('secret-123');
    expect(JSON.parse(init.body)).toEqual({
      companyId: 'company-1',
      actorUserId: 'user-1',
      billingEmail: 'dana@northwind.test',
    });
  });

  it('setCompanyBillingEmail throws CreditApiError carrying the parsed body on a non-2xx', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'forbidden' }, false, 403));

    await expect(
      setCompanyBillingEmail({
        companyId: 'company-1',
        actorUserId: 'user-1',
        billingEmail: 'dana@northwind.test',
      })
    ).rejects.toMatchObject({ status: 403, body: { error: 'forbidden' } });
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

describe('callSessionApi (BAL-519 cooldown parsing)', () => {
  const originalApiUrl = process.env.API_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_URL = 'http://api.test';
  });
  afterEach(() => {
    process.env.API_URL = originalApiUrl;
  });

  it('parses cooldownSeconds off a 429 body into retryAfterSeconds', async () => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ error: 'rate_limited', cooldownSeconds: 42 }, false, 429)
    );
    const result = await callSessionApi('/sessions/x/statement', 'GET');
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(429);
    expect(result.retryAfterSeconds).toBe(42);
  });

  it('omits retryAfterSeconds when the failure body carries none', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'rate_limited' }, false, 429));
    const result = await callSessionApi('/sessions/x/statement', 'GET');
    if (result.ok) throw new Error('expected failure');
    expect(result).not.toHaveProperty('retryAfterSeconds');
  });

  it.each([
    ['a string', '42'],
    ['null', null],
    ['NaN', Number.NaN],
    ['negative', -1],
    // TECH6 (fix round 1) — `Retry-After` is `delta-seconds`, an integer; `4.5` is not a valid
    // header value even though it is finite and non-negative.
    ['non-integer', 4.5],
  ])('treats a %s cooldownSeconds as absent', async (_label, value) => {
    mockLoggedFetch.mockResolvedValue(
      jsonResponse({ error: 'rate_limited', cooldownSeconds: value }, false, 429)
    );
    const result = await callSessionApi('/sessions/x/statement', 'GET');
    if (result.ok) throw new Error('expected failure');
    expect(result).not.toHaveProperty('retryAfterSeconds');
  });

  // The load-bearing one: the api sends BOTH a `Retry-After` header and a body field, and this
  // client must read the BODY. A header-only 429 must yield nothing.
  it('reads the BODY only — a Retry-After header is never consulted', async () => {
    const response = jsonResponse({ error: 'rate_limited' }, false, 429);
    (response as unknown as { headers: Headers }).headers = new Headers({ 'Retry-After': '99' });
    mockLoggedFetch.mockResolvedValue(response);
    const result = await callSessionApi('/sessions/x/statement', 'GET');
    if (result.ok) throw new Error('expected failure');
    expect(result).not.toHaveProperty('retryAfterSeconds');
  });

  it('leaves a non-429 failure untouched — no cooldown, no companies', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'session_not_found' }, false, 404));
    const result = await callSessionApi('/sessions/x/statement', 'GET');
    if (result.ok) throw new Error('expected failure');
    expect(result).not.toHaveProperty('retryAfterSeconds');
    expect(result).not.toHaveProperty('companies');
  });
});
