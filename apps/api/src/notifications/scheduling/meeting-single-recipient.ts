/**
 * BAL-654 / BAL-658 — THE SINGLE RECIPIENT OF A MEETING-SCOPED PROMISE, AND ITS SMS GATE.
 *
 * Shared by the waiting-party SMS and the pre-call reminders so neither can disagree about who "the
 * client" or "the expert" is. Both resolve ONE PERSON, never a role:
 *
 *   · client side → the meeting's booker only, and only while they still hold `participate` on the
 *     owning company. A system-booked meeting has no booker, so it has no client recipient.
 *   · expert side → the delivering expert's own user, never their agency's owners or admins.
 *
 * The zone feeds only the time shown in the message: the expert's profile zone first, then their
 * saved zone; the booker's saved zone. `null` when none is usable.
 */
import { clientPartyRecipientsRepository, usersRepository } from '@balo/db';
import { deliveringExpertUserId } from '../../services/meetings/delivering-party.js';
import { offlineCalleePresence } from '../../services/call-now/callee-presence.js';
import { smsEligibility } from '../../services/call-now/sms-reach.js';
import { usableRecipientZone } from '../channels/templates/sms-templates.js';

export type SingleRecipientSide = 'client' | 'expert';

export interface SingleRecipientInput {
  readonly meetingId: string;
  readonly companyId: string;
  readonly expertProfileId: string | null;
}

export type SingleRecipientResult =
  | { readonly ok: true; readonly userId: string; readonly timeZone: string | null }
  | { readonly ok: false; readonly reason: 'no_booker' | 'no_expert' };

/** The SMS gate reasons that can fire with the quiet-hours gate held open. */
export type SmsIneligibleReason = Exclude<
  Extract<ReturnType<typeof smsEligibility>, { eligible: false }>['reason'],
  'outside_hours'
>;

async function resolveBooker(input: SingleRecipientInput): Promise<SingleRecipientResult> {
  const bookerUserId = await clientPartyRecipientsRepository.findMeetingBookerUserId(
    input.meetingId
  );
  if (
    bookerUserId === null ||
    !(await clientPartyRecipientsRepository.bookerStillParticipatesInCompany(
      input.companyId,
      bookerUserId
    ))
  ) {
    return { ok: false, reason: 'no_booker' };
  }
  const context = await usersRepository.findTimezoneContext(bookerUserId, undefined);
  return { ok: true, userId: bookerUserId, timeZone: usableRecipientZone(context?.savedTimezone) };
}

async function resolveExpert(input: SingleRecipientInput): Promise<SingleRecipientResult> {
  const expertUserId = await deliveringExpertUserId(input.expertProfileId);
  if (expertUserId === null) {
    return { ok: false, reason: 'no_expert' };
  }
  const context = await usersRepository.findTimezoneContext(
    expertUserId,
    input.expertProfileId ?? undefined
  );
  return {
    ok: true,
    userId: expertUserId,
    timeZone:
      usableRecipientZone(context?.expert?.timezone) ?? usableRecipientZone(context?.savedTimezone),
  };
}

/** Resolve the one person a meeting-scoped promise goes to on `side`. */
export function resolveMeetingSingleRecipient(
  side: SingleRecipientSide,
  input: SingleRecipientInput
): Promise<SingleRecipientResult> {
  return side === 'client' ? resolveBooker(input) : resolveExpert(input);
}

/**
 * BAL-652's SMS gates (verified number, client opt-in, not active in the app) WITHOUT quiet hours:
 * the recipient booked this time, so the text is expected whenever it falls. `null` = eligible.
 */
export async function smsIneligibilityHoursOpen(
  side: SingleRecipientSide,
  userId: string
): Promise<SmsIneligibleReason | null> {
  const eligibility = smsEligibility({
    calleeSide: side,
    consent: await usersRepository.findClientSmsConsent(userId),
    calleeOnline: await offlineCalleePresence.isOnline(userId),
    withinCallHours: true,
  });
  if (eligibility.eligible) {
    return null;
  }
  // `withinCallHours` is held open above, so `smsEligibility` never answers `outside_hours`; the
  // narrowing keeps that a compile-time fact rather than a cast.
  if (eligibility.reason === 'outside_hours') {
    throw new Error('smsEligibility answered outside_hours with withinCallHours held open');
  }
  return eligibility.reason;
}
