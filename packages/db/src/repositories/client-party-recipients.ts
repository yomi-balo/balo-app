import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { auditEventsRepository } from './audit-events';
import { partyMembershipsRepository } from './party-memberships';
import type { MeetingAuditAction } from './_shared/meeting-audit';

/**
 * client-party-recipients — who on the CLIENT side of a meeting is addressed by a
 * party-visible notification (client-absent nudge, reschedule proposal, booking cancelled).
 *
 * The rule: the owning company's owner/admins (`MANAGE_MEMBERS` holders) UNION the meeting's
 * booker, for as long as the booker still holds `PARTICIPATE` on that company. The booker is
 * the actor on the meeting's latest `meeting.booked` audit row.
 *
 * Why not every live member: the booker is the one non-admin who has a stake in the meeting,
 * so addressing them keeps a member's own booking from being invisible to them without
 * fanning every notification out to the whole company.
 *
 * Unreachable by design: a guest or delegate without a `users` row has no user id to address.
 * A booking with no resolvable booker (no audit row, a NULL actor from a seeded or system
 * booking) resolves to the admins alone.
 *
 * `bookerAddedBeyondAdmins` distinguishes the booker the rule ADDS from one the admin set already
 * contained, so a consumer can measure how much the widening reaches.
 *
 * The role→capability meaning comes from `@balo/shared/authz`; no role string is read here.
 */

const MEETING_BOOKED_ACTION: MeetingAuditAction = 'meeting.booked';

export interface ClientPartyRecipients {
  /** Admins first, then the booker when they are not already an admin. Deduplicated. */
  readonly recipientUserIds: string[];
  /** True when the booker is part of `recipientUserIds` (as an admin or as a live participant). */
  readonly includedBookingMember: boolean;
  /** True only when the booker was APPENDED: not an admin, and still holds `participate`. */
  readonly bookerAddedBeyondAdmins: boolean;
}

/**
 * THE one definition of "the meeting's booker": the actor on the latest `meeting.booked` audit
 * row. `null` when no such row exists or its actor is NULL.
 */
async function findMeetingBookerUserId(meetingId: string): Promise<string | null> {
  const row = await auditEventsRepository.findLatestByEntityAndAction({
    entityType: 'meeting',
    entityId: meetingId,
    action: MEETING_BOOKED_ACTION,
  });
  return row?.actorUserId ?? null;
}

/**
 * Whether `bookerUserId` still holds a LIVE membership of `companyId` whose role grants
 * `PARTICIPATE`. A departed (soft-removed) or foreign-company booker is false.
 */
async function bookerStillParticipatesInCompany(
  companyId: string,
  bookerUserId: string
): Promise<boolean> {
  const role = await partyMembershipsRepository.getMemberRole('company', companyId, bookerUserId);
  return role !== undefined && roleHasCapability(role, CAPABILITIES.PARTICIPATE);
}

async function resolveClientPartyRecipients(input: {
  readonly meetingId: string;
  readonly companyId: string;
}): Promise<ClientPartyRecipients> {
  const [adminUserIds, bookerUserId] = await Promise.all([
    partyMembershipsRepository.listAdminUserIds('company', input.companyId),
    findMeetingBookerUserId(input.meetingId),
  ]);
  if (bookerUserId === null) {
    return {
      recipientUserIds: adminUserIds,
      includedBookingMember: false,
      bookerAddedBeyondAdmins: false,
    };
  }
  if (adminUserIds.includes(bookerUserId)) {
    return {
      recipientUserIds: adminUserIds,
      includedBookingMember: true,
      bookerAddedBeyondAdmins: false,
    };
  }
  if (await bookerStillParticipatesInCompany(input.companyId, bookerUserId)) {
    return {
      recipientUserIds: [...adminUserIds, bookerUserId],
      includedBookingMember: true,
      bookerAddedBeyondAdmins: true,
    };
  }
  return {
    recipientUserIds: adminUserIds,
    includedBookingMember: false,
    bookerAddedBeyondAdmins: false,
  };
}

export const clientPartyRecipientsRepository = {
  findMeetingBookerUserId,
  bookerStillParticipatesInCompany,
  resolveClientPartyRecipients,
};
