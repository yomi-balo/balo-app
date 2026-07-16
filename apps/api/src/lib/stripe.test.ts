import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('stripe', async () => (await import('../test/mocks/stripe.js')).stripeMockModule());
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getWebhookSecret, STRIPE_API_VERSION } from './stripe.js';
import { StripeConfigError } from '../services/stripe/errors.js';

describe('STRIPE_API_VERSION', () => {
  it('is pinned to the version stripe@22 ships as LatestApiVersion', () => {
    expect(STRIPE_API_VERSION).toBe('2026-06-24.dahlia');
  });
});

describe('getWebhookSecret', () => {
  const original = process.env.STRIPE_WEBHOOK_SECRET;
  afterEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = original;
  });

  it('returns the secret when set', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
    expect(getWebhookSecret()).toBe('whsec_test_123');
  });

  it('throws StripeConfigError when unset', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => getWebhookSecret()).toThrow(StripeConfigError);
  });
});

describe('getStripeClient', () => {
  const original = process.env.STRIPE_SECRET_KEY;
  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = original;
    vi.resetModules();
  });

  it('throws StripeConfigError when STRIPE_SECRET_KEY is unset', async () => {
    vi.resetModules();
    delete process.env.STRIPE_SECRET_KEY;
    const mod = await import('./stripe.js');
    expect(() => mod.getStripeClient()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('constructs and memoizes a single client when the key is set', async () => {
    vi.resetModules();
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    const mod = await import('./stripe.js');
    const first = mod.getStripeClient();
    const second = mod.getStripeClient();
    expect(first).toBe(second);
  });
});
