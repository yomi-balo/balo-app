import 'server-only';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';

/**
 * Server-only client for the apps/api internal credit routes (BAL-377). The Stripe provider
 * layer + `STRIPE_SECRET_KEY` live on apps/api (Railway); apps/web cannot import them, so
 * intent-creation is delegated over the established internal-secret hop — mirrors
 * `publishNotificationEvent`, but AWAITED (we need the `clientSecret` back). apps/web owns
 * authz + wallet resolution + config + analytics; apps/api owns the Stripe SDK call.
 */

function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

/** Thrown when a credit intent-creation call to apps/api fails (caught at the action boundary). */
export class CreditApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'CreditApiError';
  }
}

async function postInternal<T>(path: string, body: unknown): Promise<T> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    throw new CreditApiError('INTERNAL_API_SECRET is not configured');
  }
  const response = await loggedFetch(`${getApiUrl()}${path}`, {
    service: 'balo-api',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': secret,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new CreditApiError(`${path} failed: ${text}`, response.status);
  }
  return (await response.json()) as T;
}

export interface PurchaseIntentInput {
  walletId: string;
  presentmentCurrency: string;
  presentmentAmountMinor: number;
  initiatingMemberId: string;
  clientRequestId: string;
  promoCode?: string;
}

export interface PurchaseIntentResult {
  clientSecret: string;
  paymentIntentId: string;
}

export interface SetupIntentResult {
  clientSecret: string;
  setupIntentId: string;
  customerId: string;
}

/** Create the on-session purchase PaymentIntent (deferred flow) → its `clientSecret`. */
export async function createPurchaseIntent(
  input: PurchaseIntentInput
): Promise<PurchaseIntentResult> {
  return postInternal<PurchaseIntentResult>('/credit/purchase-intent', input);
}

/** Create the off-session mandate SetupIntent → its `clientSecret` (card-backed modes). */
export async function createMandateSetupIntent(walletId: string): Promise<SetupIntentResult> {
  return postInternal<SetupIntentResult>('/credit/setup-intent', { walletId });
}
