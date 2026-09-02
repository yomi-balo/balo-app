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

/**
 * A structured failure body the api returned alongside a non-2xx. Present only for the
 * outcomes the action layer must distinguish from a generic fault — today, the saved-card
 * `declined` (402) and `no_saved_card` (400).
 */
export interface CreditApiErrorBody {
  outcome?: string;
  error?: string;
  code?: string | null;
}

/** Thrown when a credit intent-creation call to apps/api fails (caught at the action boundary). */
export class CreditApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /**
     * The PARSED failure body, when the api sent one. A card decline is a user outcome, not a
     * system fault — without this the action could only report "something went wrong" and the
     * buyer would never learn their card was refused or why.
     */
    public readonly body?: CreditApiErrorBody
  ) {
    super(message);
    this.name = 'CreditApiError';
  }
}

/** Parse a failure body defensively — a non-JSON error page must not mask the real status. */
function parseErrorBody(text: string): CreditApiErrorBody | undefined {
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const rec = parsed as Record<string, unknown>;
    return {
      ...(typeof rec['outcome'] === 'string' ? { outcome: rec['outcome'] } : {}),
      ...(typeof rec['error'] === 'string' ? { error: rec['error'] } : {}),
      ...(typeof rec['code'] === 'string' ? { code: rec['code'] } : {}),
    };
  } catch {
    return undefined;
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
    // The body is read and CARRIED, not discarded: the caller distinguishes a card decline
    // (402 `declined`) from a genuine fault, and the two get different user copy.
    throw new CreditApiError(`${path} failed: ${text}`, response.status, parseErrorBody(text));
  }
  return (await response.json()) as T;
}

/** Which card a purchase charges — a NEW one entered in the Payment Element, or the stored one. */
export type PaymentMethodSource = 'new_card' | 'saved_card';

export interface PurchaseIntentInput {
  walletId: string;
  presentmentCurrency: string;
  presentmentAmountMinor: number;
  initiatingMemberId: string;
  clientRequestId: string;
  promoCode?: string;
  paymentMethodSource: PaymentMethodSource;
}

/**
 * The purchase-intent response, discriminated on `outcome`:
 *  · `needs_client_confirmation` — new card: the browser confirms the secret against the Element
 *  · `complete`                  — stored card: already confirmed server-side, nothing left to do
 *  · `requires_action`           — stored card: the browser must run 3DS via `handleNextAction`
 * A decline never appears here — it arrives as a 402 `CreditApiError` with a parsed body.
 */
export type PurchaseIntentResult =
  | { outcome: 'needs_client_confirmation'; clientSecret: string; paymentIntentId: string }
  | { outcome: 'complete'; paymentIntentId: string }
  | { outcome: 'requires_action'; clientSecret: string; paymentIntentId: string };

export interface SetupIntentResult {
  clientSecret: string;
  setupIntentId: string;
  customerId: string;
}

/** The outcome of confirming a mandate against the wallet's already-stored card. */
export interface SavedCardMandateResult {
  status: 'succeeded' | 'requires_action' | 'failed';
  clientSecret: string | null;
}

/** Create the on-session purchase PaymentIntent → the outcome the composer must act on. */
export async function createPurchaseIntent(
  input: PurchaseIntentInput
): Promise<PurchaseIntentResult> {
  return postInternal<PurchaseIntentResult>('/credit/purchase-intent', input);
}

/** Create the off-session mandate SetupIntent → its `clientSecret` (card-backed modes). */
export async function createMandateSetupIntent(walletId: string): Promise<SetupIntentResult> {
  return postInternal<SetupIntentResult>('/credit/setup-intent', {
    walletId,
    paymentMethodSource: 'new_card',
  });
}

/**
 * Confirm the mandate against the wallet's ALREADY-STORED card (top-up redesign). Used when a
 * returning buyer paying with their saved card picks a card-backed mode — they never re-enter a
 * card we already hold. `succeeded` ⇒ nothing for the browser to do (the webhook activates it);
 * `requires_action` ⇒ the returned secret runs 3DS.
 */
export async function confirmSavedCardMandate(
  walletId: string,
  clientRequestId: string
): Promise<SavedCardMandateResult> {
  return postInternal<SavedCardMandateResult>('/credit/setup-intent', {
    walletId,
    paymentMethodSource: 'saved_card',
    clientRequestId,
  });
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
