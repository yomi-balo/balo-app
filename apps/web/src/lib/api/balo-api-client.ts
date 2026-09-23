import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';
import { consumeApiAccountRefusal } from '@/lib/auth/api-account-refusal';
import { isAccessTokenExpired } from '@/lib/auth/access-token';
import { isAccountRefusalCode } from '@balo/shared/authz';

/**
 * Fix round 1 item 9 — THE ONE FETCH+AUTH+ERROR-MAPPING SHAPE, extracted from
 * `lib/booking/booking-api-client.ts` and `lib/meetings/reschedule-proposal-api-client.ts`,
 * which had re-declared it byte-for-byte (`getApiUrl`, `safeParse`, `readString`, `readInstant`,
 * `readRetryAfter`, and the whole `postJson`/`callBookingApi` body) — the exact SonarCloud
 * new-code duplication shape a prior docblock called "deliberate" while doing precisely what
 * CPD penalises. Every `apps/web` → `apps/api` server-only hop with a single `requireAuth`-gated
 * route and a WorkOS-Bearer-resolved-server-side auth posture goes through this module now; each
 * caller keeps only its own `parse*Response` functions and route paths.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure.
 * ⚠ NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL. A caller that needs more of
 * a non-2xx body (a cooldown, an attempts counter) supplies its own `parseFailure` to
 * {@link postBaloApiJsonWithFailureDetail}, exactly as `parse` owns the 2xx body.
 */

/** ⚠ 3002, NOT 3001 — CLAUDE.md's port table is stale; the API dev server listens on 3002. */
export function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

export type BaloApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** ⚠ `0` MEANS TRANSPORT, not "server said no". */
      readonly status: number;
      /** The api's FIXED literal, or `request_failed`. Never a message, never vendor prose. */
      readonly code: string;
      /** Seconds, from a `429`'s `Retry-After`. Absent unless the server sent a usable one. */
      readonly retryAfterSeconds?: number;
    };

/**
 * How close to expiry counts as dead for a PRE-FLIGHT gate. Deliberately much narrower than the
 * middleware's 60s refresh buffer: this answers "will the api reject this right now", and
 * refusing a session with 50 seconds of life left would turn a working booking into a spurious
 * "please sign in again".
 */
const PREFLIGHT_EXPIRY_BUFFER_SECONDS = 5;

/**
 * Whether the viewer's API credential is usable right now — for callers that write across more
 * than one hop, to be asked BEFORE the first write.
 *
 * ⚠ A presence check is not enough. The iron-session cookie lives 7 days while the access token
 * lives minutes, and a failed refresh only logs — it does not destroy the session. So an idle
 * viewer keeps a valid session carrying a present but expired token: the web-side hop succeeds
 * on the cookie and the `apps/api` hop 401s on the Bearer, leaving a half-written record.
 *
 * Advisory only: `apps/api` re-verifies.
 */
export async function viewerApiCredentialIsLive(): Promise<boolean> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return false;
  }
  return !isAccessTokenExpired(accessToken, PREFLIGHT_EXPIRY_BUFFER_SECONDS);
}

/**
 * Is this failure a dead credential rather than a refusal of the request itself?
 *
 * ⚠ Account-liveness refusals (BAL-568) also arrive as 401s and are excluded: telling a
 * suspended user to sign in again sends them round a loop that cannot end.
 */
export function isExpiredCredentialFailure(status: number, code: string): boolean {
  return status === 401 && !isAccountRefusalCode(code);
}

/** Parse a body as JSON, tolerating an empty one. Never throws. */
export function safeParse(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** An ISO instant the caller can safely do date arithmetic on, or `undefined`. */
export function readInstant(body: Record<string, unknown>, key: string): string | undefined {
  const value = readString(body, key);
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

/** A `Retry-After` in seconds, or `undefined`. Never negative, never `NaN`, never absurd. */
export function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, 300);
}

/** A failure plus the caller's own reading of the non-2xx body. */
export type BaloApiDetailedResult<T, F> =
  | { readonly ok: true; readonly data: T }
  | (Extract<BaloApiResult<T>, { ok: false }> & { readonly detail: F });

interface BaloApiCall<T> {
  readonly result: BaloApiResult<T>;
  /** The parsed non-2xx body; `{}` for a success, a transport failure or a missing credential. */
  readonly failureBody: Record<string, unknown>;
}

/**
 * One call to a `requireAuth`-gated `apps/api` route, with the viewer's Bearer resolved
 * server-side. `parse` turns a 2xx body into the caller's typed shape, or returns `null` on a
 * malformed one (mapped to a transport failure — the api never sends a 200 the client cannot
 * read, so this is a defensive backstop). Pass the identity function (`(parsed) => parsed as T`)
 * for a caller that does its own narrowing downstream, the `postBookMeeting`/`postInviteGuests`
 * posture.
 *
 * ⚠ FAILS CLOSED on a missing user or a missing access token. The api re-verifies the token
 * regardless, so this is a first, cheap gate rather than the boundary.
 */
export async function postBaloApiJson<T>(
  path: string,
  body: unknown,
  parse: (parsed: Record<string, unknown>) => T | null,
  logLabel: string
): Promise<BaloApiResult<T>> {
  return (await callBaloApi(path, body, parse, logLabel)).result;
}

/**
 * {@link postBaloApiJson}, plus `parseFailure`'s reading of a non-2xx body on the failure arm.
 * `parseFailure` receives `{}` when there was no body to read (transport failure, missing
 * credential, malformed 2xx), so it must tolerate absent fields.
 */
export async function postBaloApiJsonWithFailureDetail<T, F>(
  path: string,
  body: unknown,
  parse: (parsed: Record<string, unknown>) => T | null,
  parseFailure: (parsed: Record<string, unknown>) => F,
  logLabel: string
): Promise<BaloApiDetailedResult<T, F>> {
  const { result, failureBody } = await callBaloApi(path, body, parse, logLabel);
  if (result.ok) return result;
  return { ...result, detail: parseFailure(failureBody) };
}

async function callBaloApi<T>(
  path: string,
  body: unknown,
  parse: (parsed: Record<string, unknown>) => T | null,
  logLabel: string
): Promise<BaloApiCall<T>> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return { result: { ok: false, status: 401, code: 'unauthenticated' }, failureBody: {} };
  }

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const parsedBody = safeParse(await response.text());

    if (!response.ok) {
      // ⚠ ONLY READ ON A `429`. Any other status's `Retry-After` is not advice about OUR window.
      const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
      // BAL-568 — a 401 carrying the account-refusal marker is a LIVENESS refusal, not an
      // ordinary auth failure. Recorded here; the code replaces the body's generic literal so no
      // caller has to infer "suspended" from a bare 401.
      const refusal = await consumeApiAccountRefusal(response);
      return {
        result: {
          ok: false,
          status: response.status,
          code: refusal ?? readString(parsedBody, 'error') ?? 'request_failed',
          // ⚠ THE KEY IS OMITTED, NOT SET TO `undefined` — a present-but-undefined optional
          // survives an `in` check and violates the declared type under
          // `exactOptionalPropertyTypes`.
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        },
        failureBody: parsedBody,
      };
    }

    const data = parse(parsedBody);
    if (data === null) {
      log.error(`${logLabel} api returned a malformed 200 body`, { path });
      return { result: { ok: false, status: 0, code: 'request_failed' }, failureBody: {} };
    }
    return { result: { ok: true, data }, failureBody: {} };
  } catch (error) {
    // ⚠ NO TOKEN, NO EMAIL, NO DESCRIPTION HTML IN THIS LOG.
    log.error(`${logLabel} api call failed`, {
      path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { result: { ok: false, status: 0, code: 'request_failed' }, failureBody: {} };
  }
}
