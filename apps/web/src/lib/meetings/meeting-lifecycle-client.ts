import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * BAL-134 (§7.1 / §5.4) — the SERVER-ONLY web→api client for the two MEMBER meeting-lifecycle
 * routes: `GET /meetings/:meetingId/state` and `POST /meetings/:meetingId/end`.
 *
 * ⚠⚠ **A SERVER MODULE PLUS SERVER ACTIONS. NEVER A BROWSER FETCH.** Both routes are
 * `requireAuth`-gated and need the viewer's WorkOS access token as a Bearer; that token is
 * resolved from the iron-session SERVER-SIDE and the browser must never hold it. The identical
 * posture — and the identical reasoning — as `guests-api-client.ts` and `join-api-client.ts`.
 *
 * ⚠⚠ **ONE MODULE FOR BOTH ROUTES, ON PURPOSE.** The plan named it `meeting-state-client.ts`
 * for the read alone; a second module for the write would be a second copy of the Bearer
 * helper, the `Retry-After` clamp and the error mapping — ~40 near-identical lines, which is
 * exactly the shape SonarCloud's 3%-duplication gate flags and no local gate catches. One
 * `callMeetingApi` serves both, so the two can never disagree about how a `429` or a transport
 * failure is read.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure
 * the action layer maps to fixed copy. An exception escaping a Server Action becomes a Next
 * error boundary, which is the wrong shape for either "the mirror is a beat stale" or "we
 * couldn't end the call".
 *
 * ⚠ `status: 0` IS THE TRANSPORT SENTINEL and callers MUST treat it as RETRYABLE — the
 * `join-api-client.ts` discipline verbatim. It is a dropped connection, not a verdict.
 *
 * ⚠ THIS MODULE IS DELIBERATELY **ABSENT** FROM `meeting-call-no-lens-gate.test.ts`'s
 * `CALL_LIB_FILES` ALLOW-LIST, on exactly the grounds `guests-api-client.ts` and
 * `join-api-client.ts` already are: it is `server-only` and therefore legitimately imports
 * `@/lib/logging`, which that invariant forbids in the client tier.
 */

/**
 * ⚠ 3002, NOT 3001. CLAUDE.md's port table is stale; the API dev server listens on 3002. The
 * same helper shape as `lib/meetings/guests-api-client.ts`, so the two cannot disagree.
 */
function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

export type MeetingApiResult<T> =
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

/** A `Retry-After` in seconds, or `undefined`. ⚠ Never negative, never `NaN`, never absurd. */
function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  // ⚠ CLAMPED. It becomes a poll delay on a live call; an upstream offering a six-hour
  // cooldown must not be honoured verbatim on a surface somebody is watching.
  return Math.min(seconds, 300);
}

/**
 * One call to a member meeting route, with the viewer's Bearer resolved server-side.
 *
 * ⚠ FAILS CLOSED on a missing user or a missing access token. The api re-verifies the token
 * regardless, so this is a first, cheap gate rather than the boundary — `apps/api`'s
 * `authorizeMeetingParticipation` is what actually decides, per meeting, on the other side of
 * HTTP.
 *
 * ── ⚠⚠ A NON-GET CARRIES `{}` AS ITS BODY, AND THAT IS NOT COSMETIC ────────────────────────
 *
 * This helper used to set `Content-Type: application/json` UNCONDITIONALLY and never set a
 * `body`. On the `POST` arm `fetch` therefore sent `Content-Length: 0` with a JSON content type,
 * and **Fastify's default JSON parser rejects that with `FST_ERR_CTP_EMPTY_JSON_BODY` (400)
 * BEFORE the route handler runs** — so `endMeeting()` failed on EVERY press in production. The
 * person saw {@link END_MEETING_FAILED_COPY}, the Daily room was never deleted and the presence
 * intervals stayed open: the exact defect BAL-134 exists to remove.
 *
 * ⚠ NO EXISTING GATE CAUGHT IT. `apps/api`'s `end.test.ts` drives the route through
 * `app.inject`, which sends no content-type and therefore never reaches the parser. The
 * regression guard is a test on THIS side asserting the outgoing `fetch` init carries a body —
 * see `meeting-lifecycle-client.test.ts`.
 *
 * ⚠ THE SIBLING WAS ALWAYS RIGHT: `join-api-client.ts` sends `JSON.stringify(body ?? {})` on its
 * POST. This one now matches it, and the two cannot disagree again.
 */
async function callMeetingApi<T>(
  path: string,
  method: 'GET' | 'POST'
): Promise<MeetingApiResult<T>> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return { ok: false, status: 401, code: 'unauthenticated' };
  }

  // ⚠ A GET CARRIES NEITHER — a JSON content type on a bodyless GET is a claim about a payload
  // that is not there, and some proxies treat the pair as malformed.
  const hasBody = method !== 'GET';

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${accessToken}`,
      },
      // ⚠⚠ `'{}'`, NOT OMITTED. The end route takes no parameters (the server re-resolves both
      // authority axes from the session), but "no parameters" still has to be spelled on the
      // wire as an empty JSON object or Fastify's parser refuses the request. See above.
      ...(hasBody ? { body: JSON.stringify({}) } : {}),
    });

    const parsed = safeParse(await response.text());

    if (!response.ok) {
      // ⚠ ONLY READ ON A `429`. Any other status's `Retry-After` is not advice about OUR
      // window, and quoting an unrelated upstream's opinion at a live poll is worse than
      // silence.
      const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
      return {
        ok: false,
        status: response.status,
        code: typeof parsed.error === 'string' ? parsed.error : 'request_failed',
        // ⚠ THE KEY IS **OMITTED**, NOT SET TO `undefined` — a present-but-undefined optional
        // survives an `in` check and violates the declared type under
        // `exactOptionalPropertyTypes`.
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    // ⚠ `parsed as T` — AN UNCHECKED CAST, AND THE CALLER MUST NOT TRUST IT. The state body is
    // validated by `parseMeetingState`; see that module's docblock.
    return { ok: true, data: parsed as T };
  } catch (error) {
    log.error('Meeting lifecycle api call failed', {
      path,
      method,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, status: 0, code: 'request_failed' };
  }
}

/** `GET /meetings/:meetingId/state` — the polled mirror. ⚠ Member-only; no guest surface. */
export async function getMeetingState(meetingId: string): Promise<MeetingApiResult<unknown>> {
  return callMeetingApi<unknown>(`/meetings/${meetingId}/state`, 'GET');
}

/**
 * The end route's body. ⚠ `alreadyEnded` distinguishes D10's idempotent second end from a
 * first one — a SUCCESS on both arms.
 */
export interface EndMeetingResponse {
  status?: string;
  alreadyEnded?: boolean;
  endedBy?: string | null;
}

/**
 * `POST /meetings/:meetingId/end` — **THE ACT THAT ACTUALLY ENDS THE MEETING.**
 *
 * ⚠⚠ IT REPLACES A CLIENT-SIDE `updateParticipants({ '*': { eject: true } })`, WHICH REVOKED
 * NOTHING. A Daily token survives an eject (`eject_at_token_exp` is false and `exp` is
 * scheduled end + 24h), so the shipped BAL-435 control disconnected people who could
 * immediately rejoin. This route closes the presence intervals, writes `status='ended'` with
 * `ended_at`/`ended_by` in one transaction, and DELETES the Daily room.
 *
 * ⚠ NO PARAMETERS. The server re-resolves both end-authority axes from the session; there is
 * nothing a caller could usefully — or safely — send. ⚠⚠ THAT IS NOT THE SAME AS "NO BODY" ON
 * THE WIRE: the request carries an empty JSON object, because Fastify's default parser rejects
 * a zero-length body under `Content-Type: application/json` with a `400` before the handler
 * runs. See {@link callMeetingApi}'s docblock — this shipped broken and is now pinned by a test.
 */
export async function endMeeting(meetingId: string): Promise<MeetingApiResult<EndMeetingResponse>> {
  return callMeetingApi<EndMeetingResponse>(`/meetings/${meetingId}/end`, 'POST');
}
