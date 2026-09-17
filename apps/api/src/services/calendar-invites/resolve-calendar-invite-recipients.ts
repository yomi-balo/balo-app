import {
  auditEventsRepository,
  meetingContextsRepository,
  meetingGuestsRepository,
  partyMembershipsRepository,
  resolveMeetingContextOwner,
  type MeetingCalendarDeliveryMode,
} from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { guestIsAdmittedForRead, selectPrimaryMeetingContext } from '@balo/shared/meetings';
import { deliveringExpertUserId } from '../meetings/delivering-party.js';
import type {
  CalendarInviteParty,
  CalendarInviteRecipient,
} from '../../notifications/calendar-invite-spec.js';

/**
 * BAL-475 — recipient resolution for the Balo-organised ICS invite (U2 member recipients, U4
 * guest recipients). Part of the counterparty-address invariant's second scan root
 * (`services/calendar-invites/`) — names NO address anywhere in this file; every return value
 * is an id.
 */

const BOOKED_AUDIT_ACTION = 'meeting.booked';
const BOOKED_AUDIT_ENTITY_TYPE = 'meeting';

/**
 * Does the booker STILL hold `participate` on the company that owns this meeting? A departed
 * booker receives nothing — see `resolveCalendarPartyMemberUserIds`'s docblock.
 */
async function bookerStillParticipates(meetingId: string, bookerUserId: string): Promise<boolean> {
  const contexts = await meetingContextsRepository.listByMeeting(meetingId);
  const primary = selectPrimaryMeetingContext(contexts);
  if (!primary.ok) return false;

  const owner = await resolveMeetingContextOwner(primary.context);
  if (owner === undefined) return false;

  const role = await partyMembershipsRepository.getMemberRole(
    'company',
    owner.companyId,
    bookerUserId
  );
  if (role === undefined) return false;

  return roleHasCapability(role, CAPABILITIES.PARTICIPATE);
}

/**
 * U2 — THE ONE NAMED RESOLVER for member recipients of one (meeting, party). Returns 0 or 1
 * user id.
 *
 *  · client → the BOOKER only: the `meeting.booked` audit row's `actor_user_id`, the same user
 *    every shipped booking notification already resolves `client` to. NOT the company's
 *    members and NOT its admins (the rejected alternatives): members would widen a meeting's
 *    details to people who never joined it; admins is `guest-participation.ts`'s roster-FYI
 *    audience, not attendance. The booker holds the original UID, so updates must reach them.
 *    ⚠ Only while they still hold `participate` on the owning company. A departed booker
 *    receives nothing. A null actor (seeded meetings) ⇒ `[]`.
 *  · expert → the DELIVERING expert only: `deliveringExpertUserId(expertProfileId)`. Agency
 *    owners/admins receive nothing.
 *
 * `expertProfileId` is passed by the caller from the LIVE projection, never re-resolved here.
 */
export async function resolveCalendarPartyMemberUserIds(input: {
  readonly meetingId: string;
  readonly party: CalendarInviteParty;
  readonly expertProfileId: string | null;
}): Promise<string[]> {
  if (input.party === 'expert') {
    const userId = await deliveringExpertUserId(input.expertProfileId);
    return userId === null ? [] : [userId];
  }

  const audit = await auditEventsRepository.findLatestByEntityAndAction({
    entityType: BOOKED_AUDIT_ENTITY_TYPE,
    entityId: input.meetingId,
    action: BOOKED_AUDIT_ACTION,
  });
  if (audit === undefined || audit.actorUserId === null) {
    return [];
  }

  const stillParticipates = await bookerStillParticipates(input.meetingId, audit.actorUserId);
  return stillParticipates ? [audit.actorUserId] : [];
}

/**
 * U4 — live guests of ONE side holding a SEAT: `meetingGuestsRepository.listLiveByMeeting`
 * (excludes revoked/deleted) filtered by `party` and `guestIsAdmittedForRead(admission)` — the
 * ONE shared "admitted" predicate. `pending` never passes.
 */
export async function listCalendarInviteGuestIds(input: {
  readonly meetingId: string;
  readonly party: CalendarInviteParty;
}): Promise<string[]> {
  const guests = await meetingGuestsRepository.listLiveByMeeting(input.meetingId);
  return guests
    .filter((guest) => guest.party === input.party && guestIsAdmittedForRead(guest.admission))
    .map((guest) => guest.id);
}

/**
 * Composition used by the booking and reschedule fan-outs. The expert MEMBER is included only
 * when the row is `ics` (Ruling 1: never both); guests of that side are included whatever the
 * mode.
 */
export async function resolveCalendarInviteRecipients(input: {
  readonly meetingId: string;
  readonly party: CalendarInviteParty;
  readonly deliveryMode: MeetingCalendarDeliveryMode;
  readonly expertProfileId: string | null;
}): Promise<CalendarInviteRecipient[]> {
  const includeMember = input.party === 'client' || input.deliveryMode === 'ics';

  const [memberUserIds, guestIds] = await Promise.all([
    includeMember
      ? resolveCalendarPartyMemberUserIds({
          meetingId: input.meetingId,
          party: input.party,
          expertProfileId: input.expertProfileId,
        })
      : Promise.resolve([]),
    listCalendarInviteGuestIds({ meetingId: input.meetingId, party: input.party }),
  ]);

  return [
    ...memberUserIds.map((userId): CalendarInviteRecipient => ({ kind: 'user', userId })),
    ...guestIds.map((guestId): CalendarInviteRecipient => ({ kind: 'guest', guestId })),
  ];
}
