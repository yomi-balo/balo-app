import { requestExpertRelationshipsRepository } from '@balo/db';
import { hrefForMeeting, type PrimaryMeetingContext } from '@balo/shared/meetings';

/**
 * BAL-658 — the in-app page a meeting's call lives on, as a path, for the reminder's Reschedule
 * link and the member calendar invite. There is no deep link to the reschedule screen; this points
 * at the page that owns the call (the case, the engagement, the project).
 *
 * `null` when no page exists: an unverified owning row (`ownerFound` false), a request-grain
 * context whose request cannot be resolved, or a declared-but-unbuilt engagement kind. Every
 * caller renders no link for `null`.
 *
 * ⚠ THE ONLY CONTEXT→PATH TABLE IS `hrefForMeeting` (`@balo/shared/meetings`) — this function only
 * resolves the one input it cannot get from the primary context itself, the request id.
 */
export async function resolveMeetingPagePath(
  primary: PrimaryMeetingContext,
  ownerFound: boolean
): Promise<string | null> {
  return hrefForMeeting({
    owningRowFound: ownerFound,
    contextType: primary.contextType,
    contextId: ownerFound ? primary.contextId : null,
    projectRequestId: await resolveProjectRequestId(primary, ownerFound),
  });
}

async function resolveProjectRequestId(
  primary: PrimaryMeetingContext,
  ownerFound: boolean
): Promise<string | null> {
  if (!ownerFound) {
    return null;
  }
  if (primary.contextType === 'project_discovery') {
    return primary.contextId;
  }
  if (primary.contextType === 'request_interaction') {
    const relationship = await requestExpertRelationshipsRepository.findById(primary.contextId);
    return relationship?.projectRequestId ?? null;
  }
  return null;
}
