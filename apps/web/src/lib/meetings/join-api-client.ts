import 'server-only';

import { headers } from 'next/headers';
import type {
  GuestJoinState,
  JoinGrant,
  LobbyClaimState,
  MemberJoinResponse,
} from '@balo/shared/meetings';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';

/**
 * BAL-132 — the SERVER-ONLY web→api client for the three join routes. Modelled on
 * `lib/credit/api-client.ts`'s `callSessionApi`, the shipped precedent for this hop.
 *
 * ⚠⚠ TWO DIFFERENT AUTH POSTURES LIVE HERE, AND THE DIFFERENCE IS THE WHOLE FEATURE:
 *
 *   · THE MEMBER HOP sends the viewer's WorkOS access token as a Bearer, resolved
 *     SERVER-SIDE from the iron-session. ⚠ The browser NEVER holds that token — it is read
 *     here, inside a Server Action, and put straight into an outbound header.
 *
 *   · THE LOBBY AND GUEST HOPS send **NO Authorization header at all**, because there is no
 *     session to read: an anonymous knocker has no account, and a guest's credential is the
 *     token itself. That token travels in the JSON BODY — never in the URL, because URLs land
 *     in access logs, proxy logs and `Referer` headers, and a guest token is deliberately NOT
 *     single-use, so one logged copy stays replayable for its whole window.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure
 * the action layer maps to non-leaking copy. An exception escaping a Server Action becomes a
 * Next error boundary, which is the wrong shape for "this link isn't active".
 *
 * ⚠ AND NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL. The api returns
 * fixed literals precisely so a UI cannot start branching on prose.
 */

/**
 * ⚠ 3002, NOT 3001. CLAUDE.md's port table is stale; the API dev server listens on 3002.
 * The same helper shape as `lib/credit/api-client.ts` so the two cannot disagree.
 */
function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

/**
 * ⚠⚠ RE-EXPORTED FROM `@balo/shared/meetings`, NOT DECLARED HERE. These three shapes cross an
 * HTTP boundary, and until the shared module existed this file's copies were linked to
 * `apps/api`'s by a COMMENT ("Mirrors `JoinGrant` in `apps/api`") and by nothing else — so
 * renaming a field on either side compiled clean on both and surfaced as a browser holding a
 * credential it could not use. BAL-435 consumes the same shape.
 *
 * ⚠ TYPE-ONLY IMPORT/EXPORT. `@balo/shared/meetings` is pure and dependency-free, so no
 * `@balo/db` value can reach a `'use client'` graph through it — but keeping this
 * `export type` makes that structurally impossible rather than merely true today.
 */
export type { GuestJoinState, JoinGrant, LobbyClaimState, MemberJoinResponse };

export type JoinApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /**
       * ⚠ `0` MEANS **TRANSPORT**, NOT "SERVER SAID NO" — a DNS failure, a dropped connection,
       * an aborted request. The action layer MUST distinguish it (and `429` / `>= 500`) from a
       * real `404`/`409`, because those are retryable and these are terminal. Collapsing them
       * is what made a network blip indistinguishable from a dead link.
       */
      readonly status: number;
      readonly code: string;
      /** Seconds, from a `429`'s `Retry-After`. ⚠ Absent unless the server sent a usable one. */
      readonly retryAfterSeconds?: number;
    };

/** Parse a body as JSON, tolerating an empty one. Never throws. */
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

/** A `Retry-After` in seconds, or `undefined`. ⚠ Never negative, never `NaN`, never absurd. */
function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  // ⚠ CLAMPED. This value becomes a `setTimeout` delay in a browser; an upstream (or a
  // mis-configured proxy) offering a six-hour cooldown must not park a tab for six hours.
  return Math.min(seconds, 300);
}

/**
 * ⚠⚠ THE ORIGINAL VISITOR'S IP, FORWARDED SO THE API CAN RATE-LIMIT PER GUEST (BAL-132 fix).
 *
 * ── WHY IT HAS TO BE FORWARDED AT ALL ───────────────────────────────────────────────────
 *
 * The two public join routes are called SERVER-TO-SERVER from these Server Actions, so the
 * address `apps/api` sees on the socket is this web tier's egress, identical for every guest on
 * the planet. Its "per-IP" windows were therefore ONE platform-wide bucket: at the lobby's
 * documented poll cadence (~264 requests/hour each) THREE concurrent waiting guests exceeded the
 * 600/hour window between them. That is a functional break at trivial load, not just a weak
 * control.
 *
 * ── ⚠⚠ THE TRUST BOUNDARY, NAMED — THIS IS THE PART TO GET RIGHT ────────────────────────
 *
 * **A BROWSER MUST NOT BE ABLE TO CHOOSE THIS VALUE**, or a visitor could evade their own
 * window, or frame somebody else's. So it is read ONLY from headers the HOSTING PLATFORM
 * writes, in decreasing order of how firmly the platform owns them:
 *
 *   1. `x-vercel-forwarded-for` — Vercel STRIPS client-supplied `x-vercel-*` on ingress, so the
 *      value is the platform's own and cannot be influenced from outside.
 *   2. `x-real-ip` — set by the platform edge on the way in.
 *   3. the **LAST** entry of `x-forwarded-for` — the platform APPENDS the true peer, so the last
 *      element is the edge's own observation. ⚠ NOT the first: a client that sends its own
 *      `x-forwarded-for` occupies the FRONT of that list, which is exactly how a spoof or a
 *      framing attempt would arrive. (`lib/magic-link`'s `clientIp` reads the FIRST entry and is
 *      documented as spoofable-and-treated-as-such; that is the right call for a per-instance
 *      scanner brake and the WRONG one here, which is why this is a separate function rather
 *      than a reuse.)
 *
 * ⚠⚠ **THE ORDER IS THE SAFETY PROPERTY — NOT THE LIST.** Branch 1 must stay first and must
 * stay a header the platform strips on ingress. Branches 2 and 3 are consulted ONLY when it
 * is absent, and on a bare `next start` (or behind any edge that neither sets
 * `x-vercel-forwarded-for` nor appends to XFF) a BROWSER-SUPPLIED `x-real-ip` or
 * `x-forwarded-for` would be taken verbatim. Reordering them, or appending a fourth
 * client-settable header, hands a visitor the ability to choose this value — which is a
 * FRAMING primitive, not merely an evasion one. See the "what actually bounds framing" note
 * below, and `join-api-client.test.ts`'s precedence test, which asserts branches 2–3 are never
 * CONSULTED while branch 1 is present rather than merely that branch 1's value wins.
 *
 * ⚠ IF NONE OF THE THREE IS PRESENT WE SEND **NOTHING** and `apps/api` falls back to its own
 * `request.ip`. Sending a placeholder would merge every such visitor into one shared bucket —
 * silently reintroducing the exact bug this fixes. ⚠⚠ AND THAT FALLBACK IS **LOGGED**, on both
 * paths: `client` then equals `peer`, so every guest on the platform collapses into the single
 * bucket `<egress>|<egress>` at 10/hr (lobby) and 600/hr (guest-join) — i.e. the original
 * platform-wide DoS, silently restored by a hosting change or a header rename. It must not be
 * possible for that to happen with no signal anywhere. One line per join request (never per
 * poll tick from the browser, which is a different process).
 *
 * ── ⚠⚠ WHAT ACTUALLY BOUNDS FRAMING, STATED HONESTLY (it is not one mechanism) ───────────
 *
 * An earlier version of this note said framing was "structurally prevented by the composite
 * key". **That is true of only one of the two attacker paths**, and stating it as a blanket
 * property invites a future editor to reorder or extend the header list believing the key
 * alone protects them. The two paths, and what bounds each:
 *
 *   · A caller who **BYPASSES this tier** and hits `apps/api` directly — bounded by the
 *     COMPOSITE KEY. `apps/api` keys its per-visitor windows on `peer|client`, never `client`
 *     alone, and their `peer` is their own address, so every key they can construct is
 *     disjoint from every key a real visitor uses. They can exhaust only their own window.
 *   · A caller who goes **THROUGH this tier** — NOT bounded by the key at all. Their `peer`
 *     IS the shared web egress, exactly like a real visitor's, so `<egress>|<victim-ip>` is a
 *     constructible key. The only thing standing between them and it is that **a browser
 *     cannot choose what this function returns**, which is true on Vercel because branch 1
 *     always wins and Vercel strips client-supplied `x-vercel-*` on ingress — and which is
 *     NOT true of branches 2 and 3 on a host that leaves them client-settable.
 *
 * So: the composite key bounds the bypassing caller; **the header-selection ORDER above is
 * what bounds the caller who comes through here.** Not exploitable on the shipped topology
 * (apps/web is on Vercel), and written down because the argument, not the outcome, is what a
 * future edit will be checked against.
 *
 * ⚠ We deliberately do NOT authenticate this header with `INTERNAL_API_SECRET`: these two
 * routes are PUBLIC by design and must stay callable without it.
 */
async function resolveVisitorIp(): Promise<string | undefined> {
  try {
    const headerList = await headers();
    const platform = headerList.get('x-vercel-forwarded-for') ?? headerList.get('x-real-ip');
    if (platform !== null && platform.trim().length > 0) {
      return platform.trim();
    }
    const forwarded = headerList.get('x-forwarded-for');
    // ⚠ THE LAST ENTRY — the platform-appended one. See the docblock.
    const last = forwarded?.split(',').at(-1)?.trim();
    if (last !== undefined && last.length > 0) {
      return last;
    }
    warnVisitorIpUnresolved('no_platform_header');
    return undefined;
  } catch (error) {
    // Outside a request scope (a test harness, a build-time render). The api falls back.
    warnVisitorIpUnresolved('headers_unavailable', error);
    return undefined;
  }
}

/**
 * ⚠ THE SIGNAL THAT THE PER-VISITOR WINDOWS HAVE COLLAPSED. Both no-resolution paths land
 * here rather than returning `undefined` silently — see `resolveVisitorIp`'s docblock. This is
 * a `warn`, not an `error`: the request still succeeds and the api still rate-limits, just
 * platform-wide instead of per guest. ⚠ It carries NO header VALUES, only which branch failed.
 */
function warnVisitorIpUnresolved(
  reason: 'no_platform_header' | 'headers_unavailable',
  error?: unknown
): void {
  log.warn(
    'Visitor IP unresolved — the api per-visitor rate-limit windows collapse to the web egress',
    {
      reason,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    }
  );
}

/**
 * One call to the join api.
 *
 * ⚠ `authorization` IS AN EXPLICIT PARAMETER RATHER THAN SOMETHING THIS FUNCTION RESOLVES.
 * Two of the three routes are PUBLIC, and a helper that silently attached a Bearer whenever a
 * session happened to exist would make the anonymous paths behave differently for a
 * signed-in visitor than for a signed-out one — a difference nothing would test and nobody
 * would expect.
 */
async function callJoinApi<T>(
  path: string,
  body: unknown,
  options?: { readonly authorization?: string; readonly forwardVisitorIp?: boolean }
): Promise<JoinApiResult<T>> {
  const authorization = options?.authorization;
  // ⚠ ONLY ON THE PUBLIC HOPS. The member arm is already identified by its Bearer, and its
  // route is deliberately not rate-limited, so there is nothing for this to key.
  const visitorIp = options?.forwardVisitorIp === true ? await resolveVisitorIp() : undefined;

  try {
    const response = await loggedFetch(`${getApiUrl()}${path}`, {
      service: 'balo-api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization === undefined ? {} : { Authorization: authorization }),
        // ⚠ THE VISITOR'S OWN ADDRESS, so the api's per-guest windows key on the GUEST rather
        // than on this tier's egress. Omitted entirely when unresolvable — see
        // `resolveVisitorIp`. ⚠ NOT `X-Forwarded-For`: appending to that would require raising
        // `trustProxy` app-wide in `apps/api`, changing how EVERY other route resolves its ip.
        ...(visitorIp === undefined ? {} : { 'x-balo-client-ip': visitorIp }),
      },
      body: JSON.stringify(body ?? {}),
    });

    const parsed = safeParse(await response.text());

    if (!response.ok) {
      // ⚠ ONLY READ ON A `429`. Any other status's `Retry-After` is not advice about OUR
      // window, and a poller that obeyed it would stall on an unrelated upstream's opinion.
      const retryAfterSeconds = response.status === 429 ? readRetryAfter(response) : undefined;
      return {
        ok: false,
        status: response.status,
        // ⚠ THE FIXED LITERAL ONLY. Never a message, never a vendor string.
        code: readString(parsed, 'error') ?? 'request_failed',
        // ⚠ THE KEY IS **OMITTED**, NOT SET TO `undefined`. A present-but-undefined optional
        // property is a different thing to an absent one: it survives an `in` check and it
        // violates the declared type under `exactOptionalPropertyTypes`.
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    return { ok: true, data: parsed as T };
  } catch (error) {
    // ⚠ NO TOKEN AND NO EMAIL IN THIS LOG — the path already identifies the operation.
    log.error('Meeting join api call failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // ⚠⚠ `status: 0` IS THE TRANSPORT SENTINEL AND CALLERS MUST TREAT IT AS **RETRYABLE**. It
    // is a dropped connection, not a verdict — and a lobby poll that gives up on it is a guest
    // told their live link is dead because one packet went missing.
    return { ok: false, status: 0, code: 'request_failed' };
  }
}

/**
 * THE MEMBER HOP. Resolves the viewer's access token server-side and forwards it as a Bearer.
 *
 * ⚠ FAILS CLOSED on a missing user, a missing access token or an un-onboarded session — the
 * api re-verifies the token regardless, so this is a first, cheap gate rather than the
 * boundary.
 */
export async function postMemberJoin(
  meetingId: string
): Promise<JoinApiResult<MemberJoinResponse>> {
  const session = await getSession();
  const accessToken = session.accessToken;
  if (session.user?.id === undefined || accessToken === undefined || accessToken.length === 0) {
    return { ok: false, status: 401, code: 'unauthenticated' };
  }
  /**
   * ⚠ `MemberJoinResponse`, NOT `JoinGrant` — BAL-435's ruling R6 put the meeting's CONTEXT on
   * the RESPONSE ENVELOPE beside the grant's five fields, so `JoinGrant` itself stays frozen and
   * both guest hops below are untouched.
   */
  return callJoinApi<MemberJoinResponse>(`/meetings/${meetingId}/join`, undefined, {
    authorization: `Bearer ${accessToken}`,
  });
}

/** THE LOBBY HOP. ⚠ NO Authorization header — the caller is anonymous by design. */
export async function postLobbyClaim(
  meetingId: string,
  name: string,
  email: string
): Promise<JoinApiResult<LobbyClaimState>> {
  return callJoinApi<LobbyClaimState>(
    `/meetings/${meetingId}/lobby`,
    { name, email },
    { forwardVisitorIp: true }
  );
}

/**
 * THE GUEST HOP. ⚠ NO Authorization header, and the token goes in the BODY.
 *
 * Serves BOTH the `pre_admitted` invitee (returns `admitted` on the first call) and the
 * `pending` lobby visitor (returns `waiting` until a host decides).
 */
export async function postGuestJoin(
  meetingId: string,
  guestToken: string
): Promise<JoinApiResult<GuestJoinState>> {
  return callJoinApi<GuestJoinState>(
    `/meetings/${meetingId}/guest-join`,
    { guestToken },
    { forwardVisitorIp: true }
  );
}
