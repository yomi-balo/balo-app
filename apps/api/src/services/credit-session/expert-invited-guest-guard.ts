/**
 * BAL-474 (ADR-1040 Amendment 7 §E, D5.9) — THE "ONLY EXPERT-INVITED GUESTS ATTENDED" GUARD, in one place.
 *
 * A delivering expert who is ALSO a member of the client company resolves to the CLIENT side, so a guest
 * THEY invite is `party = client` and would convert a floor no-show into a `held` bill on the client.
 * D5.9 refuses to bill that. The check runs at three sites, and all three read THIS definition:
 *   · a guest's admission (`open-on-behalf-of-booker.ts` — the admission-time check on the one guest);
 *   · the sessionless terminal path (`settle-sessionless-case-meeting.ts`), re-applied POST-HOC so the
 *     backstop cannot bill what admission deliberately did not;
 *   · the billing-start seam (`start-billing.ts`), so a call attended only by expert-invited guests never
 *     starts a meter.
 *
 * ⚠ RESIDUAL (Amendment 7 §E): an agency owner/admin of the delivering agency who is also a client member
 * is not guarded. A call attended only by expert-invited guests stays not billable.
 */
import { expertsRepository, meetingPresenceRepository } from '@balo/db';
import type { CaseBillingSubject } from './case-billing-subject.js';

/**
 * Is the ONLY client-party attendee a guest the DELIVERING EXPERT invited? True only when there is no
 * client-party MEMBER present, at least one client-party guest, and every such guest was invited by the
 * delivering expert. Fails closed toward billing: a delivering expert with no user, or a guest with no
 * inviter, is not "expert-invited".
 */
export async function onlyExpertInvitedGuestsAttended(
  meetingId: string,
  expertProfileId: string
): Promise<boolean> {
  const identities = await meetingPresenceRepository.clientPartyIdentities(meetingId);
  if (identities.memberUserIds.length > 0 || identities.guestInviterIds.length === 0) {
    return false;
  }
  const expert = await expertsRepository.findUserIdByProfileId(expertProfileId);
  const expertUserId = expert?.user.id;
  if (expertUserId === undefined) {
    return false;
  }
  return identities.guestInviterIds.every((inviterId) => inviterId === expertUserId);
}

/**
 * The `guard` `resolveOnBehalfOpenInput` takes, over the meeting's presence: `'expert_invited_guest'`
 * when {@link onlyExpertInvitedGuestsAttended}, else `undefined`.
 */
export function expertInvitedGuestGuard(
  meetingId: string
): (subject: CaseBillingSubject) => Promise<'expert_invited_guest' | undefined> {
  return async (subject) =>
    (await onlyExpertInvitedGuestsAttended(meetingId, subject.expertProfileId))
      ? 'expert_invited_guest'
      : undefined;
}
