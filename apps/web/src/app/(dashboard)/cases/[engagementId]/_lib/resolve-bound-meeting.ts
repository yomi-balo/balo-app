import 'server-only';

import { meetingsRepository, type Meeting } from '@balo/db';
import { log } from '@/lib/logging';

/**
 * Fix round 1 item 9 — THE B3 MEETING↔ENGAGEMENT BINDING PROOF, extracted. Byte-identical
 * across `propose-reschedule.ts`, `respond-to-reschedule-proposal.ts` and (inline, before this
 * extraction) `reschedule-consultation.ts` but for one log string — a duplication-gate trip
 * SonarCloud's new-code 3% threshold would otherwise catch.
 *
 * `meetingId` is a SEPARATE subject from `engagementId`; the caller's own `authorizeCaseMutation`
 * / engagement-axis gate says nothing about which MEETING the caller may act on.
 * `findWithContexts` reads the meeting's LIVE context rows directly (never re-derived from
 * `engagementId`) and requires a live `case` context whose `contextId` is exactly this
 * `engagementId` — closing the join two independently-passing gates would otherwise leave open
 * (a client could submit `{engagementId: A, meetingId: B}`, two cases they can each reach on
 * their own, and have this action treat B as though it belonged to A).
 *
 * @param action A short label for the log line (e.g. `'Reschedule'`, `'Reschedule proposal'`,
 *   `'Reschedule proposal answer'`) — the only thing that varied between the three call sites.
 */
export async function resolveBoundMeeting(
  meetingId: string,
  engagementId: string,
  userId: string,
  action: string
): Promise<
  { ok: true; meeting: Meeting } | { ok: false; code: 'meeting_not_found'; error: string }
> {
  const notFound = {
    ok: false as const,
    code: 'meeting_not_found' as const,
    error: "We couldn't find that consultation.",
  };
  const meetingWithContexts = await meetingsRepository.findWithContexts(meetingId);
  if (meetingWithContexts === undefined) {
    return notFound;
  }
  const { meeting, contexts } = meetingWithContexts;
  const belongsToThisCase = contexts.some(
    (context) => context.contextType === 'case' && context.contextId === engagementId
  );
  if (!belongsToThisCase) {
    log.error(`${action} meetingId does not belong to engagementId — refusing`, {
      meetingId,
      engagementId,
      userId,
    });
    return notFound;
  }
  return { ok: true, meeting };
}
