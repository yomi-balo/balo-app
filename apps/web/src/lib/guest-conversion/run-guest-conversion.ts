import 'server-only';

import { meetingGuestsRepository, type ConvertedGuestLink } from '@balo/db';
import { errorMessage, log } from '@/lib/logging';
import { trackServerAndFlush, GUEST_SERVER_EVENTS } from '@/lib/analytics/server';
import { daysSinceMeeting } from '@/lib/analytics/days-since-meeting';

/**
 * BAL-489 — the guest→member conversion post-commit helper, called INDEPENDENTLY beside
 * `runDomainJoinAndEmit` at all four new-user signup seams (`verify-email.ts`, `sign-up.ts`,
 * `sign-in.ts`, `app/api/auth/callback/route.ts`).
 *
 * Its trigger is VERIFIED-EMAIL identity at NEW-USER creation, never token possession (R1/R2).
 * It must never run for an existing user or a relink — existing members structurally never
 * "convert" (R6).
 *
 * It links through `meetingGuestsRepository.linkConvertedUser` and fires
 * `guest_converted_to_member` ONCE, only if at least one row linked, with last-touch
 * `days_since_meeting` (R8/R9).
 *
 * The whole body is swallow-and-log (R10). All four seams SCHEDULE this call with Next's
 * `after()` rather than awaiting it inline, so it runs strictly AFTER the response is sent —
 * it can neither fail nor delay signup by construction, not merely by the try/catch below.
 * No side effect runs inside a `db.transaction` (the repository self-wraps and commits before
 * returning; this helper runs strictly after).
 */

/** The same three facts every new-user seam already hands `runDomainJoinAndEmit`. */
export interface RunGuestConversionInput {
  userId: string;
  email: string;
  emailVerified: boolean;
}

/** `started_at ?? scheduled_start` — "when the meeting HAPPENED", the anchor the guest recap
 *  header uses (`load-guest-recap.ts:144`) and so the anchor `guest_recap_viewed` measures from. */
function mostRecentMeetingOccurredAt(links: readonly ConvertedGuestLink[]): Date | undefined {
  let latest: Date | undefined;
  for (const { meeting } of links) {
    const occurredAt = meeting.startedAt ?? meeting.scheduledStart;
    if (latest === undefined || occurredAt.getTime() > latest.getTime()) latest = occurredAt;
  }
  return latest;
}

export async function runGuestConversionAndEmit(input: RunGuestConversionInput): Promise<void> {
  // R1/R2 — HARD GATE, before any I/O. Only a WorkOS-verified mailbox is evidence.
  if (!input.emailVerified) return;

  try {
    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: input.userId,
      verifiedEmail: input.email,
    });
    const lastTouch = mostRecentMeetingOccurredAt(links);
    if (lastTouch === undefined) return; // 0 rows linked ⇒ no conversion, no event (R8).

    log.info('Guest rows linked to new member', {
      userId: input.userId,
      linkedGuestCount: links.length,
      guestIds: links.map((link) => link.guestId),
    });

    // R8 — ONCE per converting user, post-commit (the repository transaction has committed).
    trackServerAndFlush(GUEST_SERVER_EVENTS.GUEST_CONVERTED_TO_MEMBER, {
      days_since_meeting: daysSinceMeeting(lastTouch.toISOString()),
      distinct_id: input.userId,
    });
  } catch (error) {
    log.error('Guest conversion failed (auth unaffected)', {
      userId: input.userId,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Swallow — a linkage failure must never break or fail signup (R10).
  }
}
