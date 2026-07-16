import { vi } from 'vitest';

/**
 * Stripe SDK mock (BAL-382) — extends the testing-skill base mock with the surface the
 * provider layer uses: customers, setupIntents, paymentIntents, charges (expanded
 * balance_transaction), paymentMethods, `webhooks.constructEvent`, and the `errors`
 * classes needed for the SCA / hard-decline paths.
 *
 * Usage (the async factory sidesteps `vi.mock` hoisting — the dynamic import resolves to
 * the SAME singleton this file exports, so assertions and the SUT share one `mockStripe`):
 *
 *   vi.mock('stripe', async () => (await import('../../test/mocks/stripe')).stripeMockModule());
 *   import { mockStripe, MockStripeCardError, resetStripeMock } from '../../test/mocks/stripe';
 *   beforeEach(() => resetStripeMock());
 */

/** Base Stripe error — carries the safe-to-log fields the provider reads (`code`, `requestId`). */
export class MockStripeError extends Error {
  public code?: string;
  public requestId?: string;
  public payment_intent?: unknown;
  constructor(message: string) {
    super(message);
    this.name = 'StripeError';
  }
}

/** Card error — the SCA path checks `instanceof StripeCardError && code === 'authentication_required'`. */
export class MockStripeCardError extends MockStripeError {
  constructor(init: { code?: string; message?: string; payment_intent?: unknown }) {
    super(init.message ?? 'Your card was declined.');
    this.name = 'StripeCardError';
    this.code = init.code;
    this.payment_intent = init.payment_intent;
  }
}

export const mockStripe = {
  customers: {
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  setupIntents: {
    create: vi.fn(),
  },
  paymentIntents: {
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  charges: {
    retrieve: vi.fn(),
  },
  paymentMethods: {
    attach: vi.fn(),
  },
  webhooks: {
    constructEvent: vi.fn(),
  },
};

const stripeErrors = { StripeError: MockStripeError, StripeCardError: MockStripeCardError };

/** Default `constructEvent`: throw on the sentinel `'invalid'` signature, else parse the body. */
function defaultConstructEvent(body: string | Buffer, signature: string): unknown {
  if (signature === 'invalid') {
    throw new MockStripeError('No signatures found matching the expected signature for payload');
  }
  return JSON.parse(typeof body === 'string' ? body : body.toString());
}

/**
 * The module shape to return from `vi.mock('stripe', () => stripeMockModule())`. Uses a
 * plain named function (NOT `vi.fn`) as the constructor — vitest `new`s the implementation,
 * and an arrow implementation is not constructable ("… is not a constructor"). `new`-ing
 * this returns the shared `mockStripe`; `Stripe.errors` exposes the error classes.
 */
export function stripeMockModule(): { default: unknown } {
  const StripeConstructor = Object.assign(
    function StripeConstructor() {
      return mockStripe;
    },
    { errors: stripeErrors }
  );
  return { default: StripeConstructor };
}

/** Reset every mock fn and reinstate the default `constructEvent` behaviour. Call in `beforeEach`. */
export function resetStripeMock(): void {
  for (const resource of Object.values(mockStripe)) {
    for (const fn of Object.values(resource)) {
      fn.mockReset();
    }
  }
  mockStripe.webhooks.constructEvent.mockImplementation(defaultConstructEvent);
}
