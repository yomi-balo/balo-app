'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { AccountNotLiveError, ACCOUNT_UNREADABLE } from '@/lib/auth/account-liveness';
import { log } from '@/lib/logging';
import {
  memberJoinFailureReasonFor,
  type MemberJoinFailureReason,
} from '@/lib/meetings/member-join-failure';
import { postMemberJoin, type MemberJoinResponse } from '@/lib/meetings/join-api-client';

/**
 * BAL-132 / BAL-581 — an AUTHENTICATED Balo member joins a meeting.
 *
 * Called by the member call route (`call-client.tsx`), reached from every Join surface via
 * `memberCallPath` (case page, cases index, Up Next, expert calendar, booking).
 *
 * ⚠⚠ THIS IS THE ARM THAT **DOES** GATE ON `requireOnboardedUser()`, and the contrast with
 * its two anonymous siblings is the point rather than an inconsistency. The gate is the rule
 * for mutating Server Actions (`onboarding-mutation-gate.test.ts`); the lobby actions are the
 * documented exception because their caller has no account BY DEFINITION. A member does, so
 * the ordinary rule applies with no carve-out.
 *
 * ⚠ THE GATE HERE IS A FIRST, CHEAP CHECK — NOT THE BOUNDARY. `apps/api`'s
 * `authorizeMeetingParticipation` is what actually decides, per meeting, on two capability
 * axes, and it re-verifies the WorkOS token independently. Do not read this call as the
 * authorization.
 *
 * ⚠ AND `isOwner` IS NEVER DECIDED HERE OR SENT FROM HERE. It is the
 * `hasEngagementCapability(HOST_MEETINGS)` verdict, resolved server-side per actor, and it
 * arrives in the response. A web-layer opinion about who may host — especially one derived
 * from `activeMode` or a lens — is exactly the comparison ADR-1029 forbids.
 */

const joinSchema = z.object({ meetingId: z.string().uuid() });

/**
 * ⚠ BAL-435 (R6): the success arm carries `MemberJoinResponse` — the grant's five fields PLUS the
 * meeting's CONTEXT on the envelope. `JoinGrant` itself is unchanged, and neither guest action
 * carries the context: an anonymous caller must not learn what a meeting is attached to.
 *
 * ⚠⚠ BAL-581 — THE FAILURE ARM NOW CARRIES A TYPED `reason`, NOT A COPY STRING. The web-facing
 * copy for each reason lives in `lib/meetings/lobby.ts` (a `'use server'` file may export only
 * async functions and types — never a value), keyed off this union by `MemberJoinNotice`.
 */
export type JoinAsMemberResult =
  | { success: true; grant: MemberJoinResponse }
  | { success: false; reason: MemberJoinFailureReason };

/**
 * ⚠⚠ THE ALLOWLIST RULE, NOT COARSENESS. `memberJoinFailureReasonFor` distinguishes exactly the
 * facts `join-meeting.ts:31-42` says are safe to disclose post-authorization
 * (`meeting_not_provisioned`, `meeting_not_open_for_join`) plus two facts about the CALLER's own
 * state (an account refusal, an upstream outage); `meeting_not_found` — the one pre-authorization
 * code — collapses into `unavailable` along with everything unrecognised. See
 * `member-join-failure.ts` for the full mapping.
 */

/**
 * The `requireOnboardedUser()` catch: turns a gate refusal into a typed reason, never a thrown
 * error, so the action always resolves with `JoinAsMemberResult`.
 *
 * ⚠⚠ BAL-568 PRECEDENT (`lib/phone/actions.ts`'s `gateActor`) — AN UNREADABLE ACCOUNT ROW MUST
 * NEVER SIGN ANYONE OUT. A DB fault fails closed on access, never on the claim that an account
 * is suspended: `outage` gets the retryable card, never the session-sync redirect.
 *
 * ⚠ CLAUDE.md: `log.error` in EVERY catch that HANDLES an error and returns user-facing copy.
 * Without it the original reason — expired session vs. incomplete onboarding vs. a session-store
 * outage — is gone, and every one of them renders the same sentence.
 * ⚠ NO EMAIL, NO TOKEN, NO SESSION CONTENTS: the caller is unauthenticated by construction at
 * this point, so there is nothing safe to identify them by beyond the meeting they were trying
 * to reach.
 *
 * Not exported: a `'use server'` file may export only async functions.
 */
function gateRefusalReason(error: unknown, meetingId: unknown): MemberJoinFailureReason {
  const meetingIdForLog = typeof meetingId === 'string' ? meetingId : undefined;
  if (error instanceof AccountNotLiveError) {
    log.warn('Member meeting join refused — account not live', {
      meetingId: meetingIdForLog,
      code: error.code,
    });
    return error.code === ACCOUNT_UNREADABLE ? 'outage' : 'account_refused';
  }
  log.error('Member meeting join rejected — no onboarded session', {
    meetingId: meetingIdForLog,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return 'unavailable';
}

export async function joinAsMemberAction(input: {
  meetingId: string;
}): Promise<JoinAsMemberResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    return { success: false, reason: gateRefusalReason(error, input.meetingId) };
  }

  const parsed = joinSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: 'unavailable' };
  }

  const result = await postMemberJoin(parsed.data.meetingId);

  if (!result.ok) {
    const reason = memberJoinFailureReasonFor(result.status, result.code);
    log.warn('Member meeting join refused', {
      meetingId: parsed.data.meetingId,
      status: result.status,
      code: result.code,
      reason,
    });
    return { success: false, reason };
  }

  log.info('Member joined meeting', {
    meetingId: parsed.data.meetingId,
    isOwner: result.data.isOwner,
  });
  return { success: true, grant: result.data };
}
