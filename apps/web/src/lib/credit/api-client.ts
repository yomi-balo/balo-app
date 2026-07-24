import 'server-only';

import type { EligibleCompany } from '@balo/shared/credit';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * Server-only web→api clients for the credit surface. TWO distinct hops share this module,
 * both mirroring the internal `loggedFetch` mechanics of `../notifications/publish.ts` but
 * AWAITED (each needs the response back):
 *
 *  1. BAL-377 credit INTENT-creation (`createPurchaseIntent` / `createMandateSetupIntent`).
 *     The Stripe provider layer + `STRIPE_SECRET_KEY` live on apps/api (Railway); apps/web
 *     cannot import them, so intent-creation is delegated over the internal-secret hop
 *     (`x-internal-api-key`). apps/web owns authz + wallet resolution + config + analytics;
 *     apps/api owns the Stripe SDK call.
 *  2. BAL-378 credit-SESSION drawdown (`callSessionApi`). Those routes are WorkOS-authed
 *     (`requireAuth` → `request.userId`), NOT the internal secret — so this client forwards the
 *     viewer's WorkOS access token as `Authorization: Bearer …`, resolved SERVER-SIDE from the
 *     iron-session (the browser never supplies it). No arbitrary WALLET id is ever trusted from
 *     the client; a `companyId` (BAL-401) MAY be forwarded but is capability-gated server-side —
 *     `openSession` only honours a company the caller holds CONSUME_CREDITS on (fail-closed), so
 *     it cannot draw down another tenant's wallet. These are user-initiated mutations that toast
 *     their outcome.
 */

function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

// ── BAL-377: internal-secret credit intent-creation hop ─────────────────────────────────

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

// ── BAL-378: WorkOS-Bearer credit-session drawdown hop ──────────────────────────────────

/** The authed principal for a credit-session api call (resolved from the iron-session). */
interface SessionApiAuth {
  userId: string;
  accessToken: string;
}

/** A typed result of a credit-session api call — success carries the parsed body. */
export type ApiCallResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code?: string; error: string; companies?: EligibleCompany[] };

/**
 * Resolve the viewer's authenticated principal from the iron-session. Fails closed
 * (`null`) for a missing user, a missing access token, or an un-onboarded session —
 * the api re-verifies the token, so this is a first, cheap gate.
 */
async function resolveSessionApiAuth(): Promise<SessionApiAuth | null> {
  const session = await getSession();
  const userId = session.user?.id;
  const accessToken = session.accessToken;
  if (userId === undefined || accessToken === undefined || accessToken.length === 0) {
    return null;
  }
  if (session.user?.onboardingCompleted !== true) {
    return null;
  }
  return { userId, accessToken };
}

/** Parse a response body as JSON, tolerating an empty body (→ `{}`). */
function safeParse(text: string): Record<string, unknown> {
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * BAL-401 — defensively parse the `company_selection_required` companies list off a failure
 * body. Returns `undefined` when the field is absent/not an array; drops any item missing a
 * string `id`/`name`. `logoUrl` is nullable end-to-end (personal / logoless companies).
 */
function readEligibleCompanies(body: Record<string, unknown>): EligibleCompany[] | undefined {
  const raw = body['companies'];
  if (!Array.isArray(raw)) return undefined;
  const out: EligibleCompany[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = rec['id'];
    const name = rec['name'];
    const logoUrl = rec['logoUrl'];
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    out.push({ id, name, logoUrl: typeof logoUrl === 'string' ? logoUrl : null });
  }
  return out;
}

/**
 * Call a credit-session api route with the viewer's Bearer token. Never throws — a
 * transport error, a non-2xx, or an unauthenticated session all resolve to a typed
 * `{ ok: false }` the action layer maps to a friendly, non-leaking message.
 */
export async function callSessionApi<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<ApiCallResult<T>> {
  const auth = await resolveSessionApiAuth();
  if (auth === null) {
    return { ok: false, status: 401, error: 'Please sign in and try again.' };
  }

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const parsed = safeParse(await response.text());

    if (!response.ok) {
      const companies = readEligibleCompanies(parsed);
      return {
        ok: false,
        status: response.status,
        code: readString(parsed, 'code'),
        error: readString(parsed, 'error') ?? readString(parsed, 'code') ?? 'Request failed.',
        ...(companies === undefined ? {} : { companies }),
      };
    }

    return { ok: true, status: response.status, data: parsed as T };
  } catch (error) {
    log.error('Credit-session api call failed', {
      path,
      method,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, status: 0, error: 'Something went wrong. Please try again.' };
  }
}
