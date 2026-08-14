import 'server-only';

import type { GuestForViewer } from '@balo/shared/meetings';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * BAL-436 — the SERVER-ONLY web→api client for the four guest-roster operations.
 *
 * ⚠⚠ **A SERVER MODULE PLUS SERVER ACTIONS. NEVER A BROWSER FETCH.** `apps/api`'s guest
 * routes are `requireAuth`-gated and need the viewer's WorkOS access token as a Bearer; that
 * token is resolved from the iron-session SERVER-SIDE and the browser must never hold it. A
 * client-side fetch is therefore structurally impossible without either leaking the token or
 * inventing a proxy route. `routes/meetings/guests.ts`'s own docblock prescribes this exact
 * shape by name ("one thin client module … copying `lib/credit/api-client.ts`'s
 * `callSessionApi`"), and this follows it.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure
 * the action layer maps to fixed copy. An exception escaping a Server Action becomes a Next
 * error boundary, which is the wrong shape for "that person is no longer in the list" on a
 * live call.
 *
 * ⚠ AND NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL. The api returns
 * fixed literals precisely so a UI cannot start branching on prose (`guests.ts` contract
 * point 7). ⚠ NEVER log a guest's email address, a name or a token — ids and counts only.
 *
 * ⚠ `status: 0` IS THE TRANSPORT SENTINEL and callers MUST treat it as RETRYABLE — the
 * `join-api-client.ts` discipline verbatim. It is a dropped connection, not a verdict; a poll
 * that gave up on it would tell a host their roster is gone because one packet went missing.
 */

/**
 * ⚠ 3002, NOT 3001. CLAUDE.md's port table is stale; the API dev server listens on 3002. The
 * same helper shape as `lib/credit/api-client.ts` and `lib/meetings/join-api-client.ts`, so
 * the three cannot disagree.
 */
function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

export type GuestsApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** ⚠ `0` MEANS **TRANSPORT**, not "server said no". See the module docblock. */
      readonly status: number;
      /** The api's FIXED literal, or `request_failed`. Never a message, never vendor prose. */
      readonly code: string;
      /** Seconds, from a `429`'s `Retry-After`. ⚠ Absent unless the server sent a usable one. */
      readonly retryAfterSeconds?: number;
    };

/** Parse a body as JSON, tolerating an empty one. Never throws. */
function safeParse(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
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

/** A `Retry-After` in seconds, or `undefined`. ⚠ Never negative, never `NaN`, never absurd. */
function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  // ⚠ CLAMPED. This value becomes a message to a person on a live call; an upstream offering
  // a six-hour cooldown must not be quoted back to them verbatim.
  return Math.min(seconds, 300);
}

/**
 * One call to a guest route, with the viewer's Bearer resolved server-side.
 *
 * ⚠ FAILS CLOSED on a missing user or a missing access token. The api re-verifies the token
 * regardless, so this is a first, cheap gate rather than the boundary.
 */
async function callGuestsApi<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<GuestsApiResult<T>> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return { ok: false, status: 401, code: 'unauthenticated' };
  }

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const parsed = safeParse(await response.text());

    if (!response.ok) {
      // ⚠ ONLY READ ON A `429`. Any other status's `Retry-After` is not advice about OUR
      // window, and quoting an unrelated upstream's opinion at a host is worse than silence.
      const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
      return {
        ok: false,
        status: response.status,
        code: readString(parsed, 'error') ?? 'request_failed',
        // ⚠ THE KEY IS **OMITTED**, NOT SET TO `undefined` — a present-but-undefined optional
        // survives an `in` check and violates the declared type under
        // `exactOptionalPropertyTypes`.
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    return { ok: true, data: parsed as T };
  } catch (error) {
    // ⚠ NO EMAIL ADDRESS AND NO TOKEN IN THIS LOG — the path already identifies the operation.
    log.error('Meeting guests api call failed', {
      path,
      method,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, status: 0, code: 'request_failed' };
  }
}

/** The roster GET's body, as the api sends it. ⚠ `parsed as T` — an unchecked cast of JSON. */
export interface GuestsListResponse {
  guests: GuestForViewer[];
  canHost: boolean;
  participantCount: number;
  participantCap: number;
}

export interface GuestsInviteResponse {
  guests: Array<{ id: string }>;
  participantCount: number;
  participantCap: number;
}

/** `GET /meetings/:meetingId/guests` — the party-scoped roster plus `canHost` and the seats. */
export async function getMeetingGuests(
  meetingId: string
): Promise<GuestsApiResult<GuestsListResponse>> {
  return callGuestsApi<GuestsListResponse>(`/meetings/${meetingId}/guests`, 'GET');
}

/**
 * `POST /meetings/:meetingId/guests` — invite by email.
 *
 * ⚠⚠ **NEVER SENDS `party` OR `accessScope`.** Both are server-derived (from the actor's
 * resolved side, and from the domain rule at invite time), and a body field for either would
 * be a cross-party write. The api's Zod schema has no key for them, so a field would be
 * silently stripped — but not sending it is the control, not relying on the strip.
 *
 * ⚠ `entryPoint: 'in_call'` — the enum value already exists, and it is the funnel dimension
 * the whole guest event set exists to measure.
 */
export async function inviteMeetingGuests(
  meetingId: string,
  emails: readonly string[]
): Promise<GuestsApiResult<GuestsInviteResponse>> {
  return callGuestsApi<GuestsInviteResponse>(`/meetings/${meetingId}/guests`, 'POST', {
    entryPoint: 'in_call',
    guests: emails.map((email) => ({ email })),
  });
}

/** `POST /meetings/:meetingId/guests/:guestId/{admit,deny}` — the host's queue decision. */
export async function decideMeetingGuestAdmission(
  meetingId: string,
  guestId: string,
  decision: 'admit' | 'deny'
): Promise<GuestsApiResult<{ id: string }>> {
  return callGuestsApi<{ id: string }>(
    `/meetings/${meetingId}/guests/${guestId}/${decision}`,
    'POST'
  );
}

/**
 * `POST /meetings/:meetingId/guests/:guestId/resend-link` — re-issue a stranded guest's
 * credential.
 *
 * ⚠ THE RESPONSE CARRIES NO TOKEN, BY DESIGN. The engine emails it; this hop learns only that
 * a rotation happened and when the new window closes.
 */
export async function resendMeetingGuestLink(
  meetingId: string,
  guestId: string
): Promise<GuestsApiResult<{ id: string; expiresAt: string }>> {
  return callGuestsApi<{ id: string; expiresAt: string }>(
    `/meetings/${meetingId}/guests/${guestId}/resend-link`,
    'POST'
  );
}
