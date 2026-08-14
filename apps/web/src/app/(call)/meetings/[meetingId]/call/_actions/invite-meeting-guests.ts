'use server';

import 'server-only';

import { z } from 'zod';
import type { MeetingPanelInviteOutcome } from '@balo/analytics/client';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { inviteMeetingGuests } from '@/lib/meetings/guests-api-client';
import { GUEST_ACTION_COPY, guestActionCopyFor } from '@/lib/meetings/guests-copy';
import type { InviteMeetingGuestsResult } from '@/lib/meetings/meeting-panels';

/**
 * ⚠⚠ **THERE IS NO `party` KEY AND NO `accessScope` KEY IN THIS SCHEMA, AND THAT ABSENCE IS
 * THE CONTROL.** Both are server-derived — `party` from the actor's resolved side, and
 * `accessScope` from the domain rule at invite time — and a body field for either would let a
 * client-side member mint an expert-side participant or award a guest the whole retrospective
 * engagement envelope. The api's own Zod schema has no key for them either, so a field would
 * be silently stripped; not sending it is the control, not relying on the strip.
 *
 * ⚠ `.max(8)` MIRRORS THE API'S PARSE-TIME BOUND (`MAX_MEETING_PARTICIPANTS` minus the two
 * reserved seats). It is not the cap — the real cap counts the meeting's live guests and
 * answers `409 participant_cap_reached`, which this action maps to copy.
 */
const inputSchema = z.object({
  meetingId: z.uuid(),
  emails: z.array(z.string().trim().email().max(254)).min(1).max(8),
});

/**
 * BAL-436 — invite people to a live call by email, from the People panel's footer.
 *
 * ⚠ MUTATING ⇒ `requireOnboardedUser()`. That is the rule for every mutating Server Action
 * (`onboarding-mutation-gate.test.ts`); the anonymous lobby actions are the documented
 * exception, and an in-call host is not one.
 *
 * ⚠⚠ THE PANEL MUST NEVER PRE-EMPT `participant_cap_reached` BY DISABLING ITS OWN BUTTON.
 * `listGuests`' docblock names that exact regression by name — the seat counter and the
 * queue counter are separate resources, and a client-side `count >= cap` gate reintroduces
 * the invite lockout the counter split exists to close, moved from the server to the client.
 * The server answers `409`; this action turns it into a sentence.
 *
 * ⚠ `outcome` IS CARRIED BACK for analytics rather than re-derived from the copy — branching
 * a PostHog property on a user-facing string means every copy edit silently re-buckets a
 * dashboard.
 */
export async function inviteMeetingGuestsAction(input: {
  meetingId: string;
  emails: readonly string[];
}): Promise<InviteMeetingGuestsResult> {
  try {
    await requireOnboardedUser();
  } catch (error) {
    // ⚠ CLAUDE.md: `log.error` in EVERY catch that HANDLES an error and returns user-facing
    // copy. ⚠ NO EMAIL ADDRESSES — the count is the useful, safe field.
    log.error('In-call guest invite rejected — no onboarded session', {
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GUEST_ACTION_COPY.unauthenticated, outcome: 'failed' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: 'Enter a valid email address.',
      outcome: 'failed',
    };
  }
  const { meetingId, emails } = parsed.data;

  const result = await inviteMeetingGuests(meetingId, emails);
  if (!result.ok) {
    // ⚠ NO EMAIL ADDRESSES IN THIS LINE — the batch size and the meeting are enough to find
    // the collision from the roster; the address is the thing this feature conceals.
    log.error('In-call guest invite refused', {
      meetingId,
      guestCount: emails.length,
      status: result.status,
      code: result.code,
    });
    return {
      success: false,
      error: guestActionCopyFor(result),
      outcome: inviteOutcomeFor(result.status, result.code),
    };
  }

  log.info('Guests invited from the in-call panel', {
    meetingId,
    guestCount: result.data.guests.length,
  });
  return {
    success: true,
    invitedCount: result.data.guests.length,
    participantCount: result.data.participantCount,
    participantCap: result.data.participantCap,
  };
}

/**
 * The analytics dimension for a refusal.
 *
 * ⚠ A LOOKUP-SHAPED `if` LADDER, NOT A NESTED TERNARY (SonarCloud S3358). The three named
 * refusals have three different product remedies — a full room, a duplicate address and a
 * spent window — and collapsing them into `failed` is what makes "invites are failing"
 * unactionable in a dashboard.
 */
function inviteOutcomeFor(status: number, code: string): Exclude<MeetingPanelInviteOutcome, 'ok'> {
  if (status === 429) return 'rate_limited';
  if (code === 'participant_cap_reached') return 'cap_reached';
  if (code === 'guest_already_invited') return 'already_invited';
  return 'failed';
}
