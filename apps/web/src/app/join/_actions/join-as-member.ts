'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { postMemberJoin, type JoinGrant } from '@/lib/meetings/join-api-client';

/**
 * BAL-132 — an AUTHENTICATED Balo member joins a meeting.
 *
 * ⚠⚠ **THIS ACTION HAS ZERO PRODUCTION CALLERS TODAY, AND THAT IS DELIBERATE — IT IS A SEAM,
 * NOT DEAD CODE.** Stated here because nothing else says so: `MeetingCallSurface` carries the
 * same "shipped as a contract, not a feature" note, this did not, and a reader would reasonably
 * assume a member join flow is live somewhere. It is not. It is referenced only by its own test.
 *
 * WHO MOUNTS IT:
 *   · **BAL-435** owns the in-meeting route (`DailyProvider`, PreJoin, stage, toolbar) and is
 *     the primary consumer — it calls this, then hands the returned grant to
 *     `MeetingCallSurface`, exactly as `LobbyClient` and `JoinControl` already do for guests.
 *   · **BAL-421** owns the case surface's "join the call" entry point.
 *
 * ⚠ DO **NOT** BUILD AN ENTRY POINT FOR IT HERE. A member-facing join button needs the
 * surrounding meeting UI to be worth anything, and adding one now would ship a button that
 * renders a "Connecting…" placeholder forever.
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

export type JoinAsMemberResult =
  | { success: true; grant: JoinGrant }
  | { success: false; error: string };

/**
 * ⚠ THE THREE FAILURE MESSAGES ARE INTENTIONALLY COARSE. The api collapses "no such meeting",
 * "not your party" and "no capability" into ONE literal, so this layer cannot — and must not
 * try to — say more. The two it does distinguish are safe: a signed-out session and a genuine
 * upstream outage are facts about the CALLER's own state, not about any meeting.
 */
export async function joinAsMemberAction(input: {
  meetingId: string;
}): Promise<JoinAsMemberResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    // ⚠ CLAUDE.md: `log.error` in EVERY catch that HANDLES an error and returns user-facing
    // copy. Without it the original reason — expired session vs. incomplete onboarding vs. a
    // session-store outage — is gone, and all three render the same sentence.
    // ⚠ NO EMAIL, NO TOKEN, NO SESSION CONTENTS: the caller is unauthenticated by construction
    // at this point, so there is nothing safe to identify them by beyond the meeting they were
    // trying to reach.
    log.error('Member meeting join rejected — no onboarded session', {
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Please sign in and try again.' };
  }

  const parsed = joinSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }

  const result = await postMemberJoin(parsed.data.meetingId);

  if (!result.ok) {
    log.warn('Member meeting join refused', {
      meetingId: parsed.data.meetingId,
      status: result.status,
      code: result.code,
    });
    // A 503 is an outage the caller should retry; everything else is the uniform refusal.
    return {
      success: false,
      error:
        result.status === 503
          ? "We couldn't set up your call room just now. Please try again in a moment."
          : "This meeting isn't available to join.",
    };
  }

  log.info('Member joined meeting', {
    meetingId: parsed.data.meetingId,
    isOwner: result.data.isOwner,
  });
  return { success: true, grant: result.data };
}
