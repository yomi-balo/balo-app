'use server';

import 'server-only';

import { z } from 'zod';
import { log } from '@/lib/logging';
import { postGuestJoin, type JoinGrant } from '@/lib/meetings/join-api-client';
import { JOIN_TEMPORARILY_UNAVAILABLE_TITLE, JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';

/**
 * BAL-132 — "have I been let in yet?", and the mint when the answer is yes.
 *
 * ⚠⚠ THE SAME CALL SERVES BOTH KINDS OF GUEST, AND THAT IS DECISION 2 IN ONE SENTENCE:
 *   · a `pre_admitted` INVITEE resolves to `admitted` on the FIRST call — so there is no
 *     visible token step anywhere in their flow, which is the acceptance criterion;
 *   · a `pending` LOBBY visitor resolves to `waiting`, over and over, until a host decides.
 *
 * **A `pending` guest has NO DAILY TOKEN IN EXISTENCE ANYWHERE.** Nothing is minted, tracked
 * or written while they wait. The queue is enforced by token ISSUANCE, not by UI.
 *
 * ⚠ DELIBERATELY UNAUTHENTICATED — the token IS the credential, and a guest has no Balo
 * session to gate on. Same reasoning, and the same `onboarding-mutation-gate` position, as
 * `claim-lobby-place.ts` — which now means: this module is ALSO an entry on
 * `PUBLIC_ACTION_ALLOWLIST` (`invariants/_read-only-actions.ts`), whose exact-set-equality
 * assertion is what stops a third anonymous action landing here unnoticed. Read that file's
 * docblock, not just this sentence; the earlier framing ("passes the invariant with no
 * exclusion entry") described a state that no longer holds.
 *
 * ⚠ A DENIED GUEST GETS `unavailable`, NOT A DENIAL MESSAGE. `findLiveByTokenHash` filters
 * `denied` rows out entirely, so the api answers the same `meeting_not_found` it answers for
 * a token that never existed. Telling someone "you were denied" would confirm both that the
 * meeting is real and that a human looked at them and said no.
 */

const pollSchema = z.object({
  meetingId: z.string().uuid(),
  guestToken: z.string().min(20).max(200),
});

/**
 * ⚠⚠ THE FAILURE ARM CARRIES `retryable` AND `status`, AND THE POLLER **MUST** HONOUR THEM.
 *
 * The first cut returned a bare `{ success: false, error }`, so the client could not tell a
 * dropped packet from a dead link — and, treating everything as terminal, it stopped the
 * scheduler on the first blip. That defeated the entire 5s→15s back-off, whose only reason to
 * exist is to keep a guest inside the rate limit across a ~35-minute wait. On the patchy-signal
 * phone that IS this surface's primary context, one lost packet ended the wait.
 *
 * RETRYABLE (keep polling, bounded by a consecutive-failure counter):
 *   · `status: 0`  — TRANSPORT. A dropped connection is not a verdict.
 *   · `429`        — we are being asked to slow down, not to go away. `retryAfterSeconds`
 *                    carries the server's own advice when it sent one.
 *   · `>= 500`     — an upstream wobble, including the `503` split out below.
 *
 * TERMINAL: `404` (unknown / expired / revoked / DENIED token, or no such meeting) and `409`
 * (the meeting is not open for join). Those are answers, not accidents.
 */
export type PollGuestAdmissionResult =
  | { success: true; state: 'admitted'; grant: JoinGrant }
  | { success: true; state: 'waiting' }
  | {
      success: false;
      retryable: boolean;
      /** ⚠ `0` = transport. Never rendered; it selects behaviour, not copy. */
      status: number;
      title: string;
      retryAfterSeconds?: number;
    };

/** ⚠ Transport, throttling and upstream wobbles are RETRYABLE. `404` / `409` are not. */
function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export async function pollGuestAdmissionAction(input: {
  meetingId: string;
  guestToken: string;
}): Promise<PollGuestAdmissionResult> {
  const parsed = pollSchema.safeParse(input);
  if (!parsed.success) {
    // A malformed stored token is indistinguishable, to the visitor, from a dead one — and it
    // is genuinely terminal: retrying the same bad value forever helps nobody.
    return { success: false, retryable: false, status: 400, title: JOIN_UNAVAILABLE_TITLE };
  }

  const result = await postGuestJoin(parsed.data.meetingId, parsed.data.guestToken);

  if (!result.ok) {
    // ⚠ NO TOKEN, NOT EVEN A PREFIX, IN THIS LOG — and no email. This runs on a 5-second
    // interval, so it must also stay cheap: one line, fixed fields.
    log.warn('Guest join refused', {
      meetingId: parsed.data.meetingId,
      status: result.status,
      code: result.code,
    });
    return {
      success: false,
      retryable: isRetryableStatus(result.status),
      status: result.status,
      // ⚠⚠ THE **ONLY** UN-COLLAPSED FAILURE ON THIS SURFACE, AND IT IS SAFE FOR ONE REASON:
      // a `503` is reachable ONLY after a ≥256-bit token has already resolved AND the bearer
      // was already ADMITTED. It says "our own call-room provider did not answer", which tells
      // the holder nothing they did not already know about a meeting that is demonstrably
      // theirs. Showing them the dead-link card instead is an outright lie that costs them the
      // call.
      //
      // ⚠⚠ EVERY OTHER STATUS STAYS COLLAPSED — ESPECIALLY `429`, WHICH FIRES PRE-AUTHORIZATION.
      // Splitting that one out would tell an anonymous scanner "you are being counted".
      title: result.status === 503 ? JOIN_TEMPORARILY_UNAVAILABLE_TITLE : JOIN_UNAVAILABLE_TITLE,
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
    };
  }

  if (result.data.state === 'waiting') {
    // ⚠ NO LOG LINE ON A WAITING TICK. At one every five seconds this would be the noisiest
    // event in Axiom and would say nothing a single "claimed" line does not already say.
    return { success: true, state: 'waiting' };
  }

  log.info('Guest admitted to meeting', { meetingId: parsed.data.meetingId });
  return { success: true, state: 'admitted', grant: result.data.grant };
}
