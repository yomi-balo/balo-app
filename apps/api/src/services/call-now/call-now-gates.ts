/**
 * BAL-649 (decision 11) — THE FACTS BEHIND "CAN THIS CALLER RING RIGHT NOW?".
 *
 * ⚠ ONE LOADER BACKS BOTH THE READ VIEW (`GET /cases/:id/call-now`) AND THE ENFORCEMENT ON
 * `POST`, and both feed the one shared predicate `resolveCallNowAvailability`, so the view
 * cannot disagree with what the write will do. Each fact comes from exactly one read; reads that
 * do not depend on each other run together.
 *
 * ⚠ THE WALLET GATE IS WALLET-WIDE. A pre-ring credit session bound to the in-place candidate
 * itself therefore counts as `company_in_call`. Accepted: ringing on top of a session the
 * company already has open is the case the gate exists to refuse. It ALSO counts a ring that is
 * `ringing` on another case of the company: a ringing meeting is still `scheduled`, so no session
 * read can see it, and two members ringing two experts at once would both connect on one wallet.
 *
 * ⚠ `mayRing: false` (an expert-side holder who is not the delivering expert) resolves no callee,
 * so the action is hidden (`callee_unavailable`, reason null) on the view and refused on `POST`.
 *
 * ⚠ A BOOKING IN ITS JOIN WINDOW HIDES THE ACTION (`booking_starting`, reason null) for both
 * sides: any other meeting on the case that is live, or `scheduled` with its join window open
 * (`withinJoinWindow`, the same instant the case's Join uses), has its own Join, which is the way
 * in. The ringing ring's own meeting is not counted; a live ring refuses as `ring_in_progress`.
 *
 * ⚠ THE DECLINE COOLDOWN (`recently_declined`) is read from the ring rows in Postgres, never
 * Redis: a callee who declined this caller is not rung by them again for
 * `CALL_NOW_DECLINE_COOLDOWN_MS`.
 */
import {
  creditSessionsRepository,
  creditWalletsRepository,
  expertsRepository,
  meetingContextsRepository,
  meetingPresenceRepository,
  meetingRingsRepository,
  meetingsRepository,
  usersRepository,
  type CaseEngagementRow,
} from '@balo/db';
import { withinJoinWindow } from '@balo/shared/engagements';
import { createLogger } from '@balo/shared/logging';
import {
  CALL_NOW_DECLINE_COOLDOWN_MS,
  isRingLive,
  isWithinCallHours,
  resolveCallNowAvailability,
  selectInPlaceCandidate,
  type CallSide,
} from '@balo/shared/meetings';
import { offlineCalleePresence, type CalleePresence } from './callee-presence.js';
import { resolveCallee } from './resolve-callee.js';

const log = createLogger('call-now-gates');

export interface CallNowGates {
  availability: ReturnType<typeof resolveCallNowAvailability>;
  /** `null` when no callee could be resolved. */
  callee: { userId: string; timeZone: string } | null;
  /** The same-day booking a CLIENT caller may ring in place; always `null` for an expert caller. */
  inPlaceCandidate: { meetingId: string; scheduledStart: Date } | null;
  expertProfileId: string;
  companyId: string;
}

export interface LoadCallNowGatesInput {
  caseRow: CaseEngagementRow;
  side: CallSide;
  userId: string;
  /** From `authorizeCallNow`: `false` for an expert-side holder who is not the delivering expert. */
  mayRing: boolean;
  now: Date;
  presence?: CalleePresence;
}

function isUsableTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

async function companyHasOtherLiveSession(caseRow: CaseEngagementRow): Promise<boolean> {
  const { companyId } = caseRow;
  const wallet = await creditWalletsRepository.findByCompanyId(companyId);
  const [walletSession, sessionless, ringingElsewhere] = await Promise.all([
    wallet === undefined
      ? Promise.resolve(false)
      : creditSessionsRepository.hasActiveSessionForWallet(wallet.id),
    meetingsRepository.hasLiveSessionlessCaseMeeting({ companyId }),
    meetingRingsRepository.hasRingingOnOtherCompanyCase({
      companyId,
      excludeEngagementId: caseRow.id,
    }),
  ]);
  return walletSession || sessionless || ringingElsewhere;
}

type CaseMeeting = Awaited<
  ReturnType<typeof meetingContextsRepository.listMeetingsForContext>
>[number];

/**
 * The caller's saved zone, which judges "the same day" for an in-place booking. An in-place
 * booking is a CLIENT-only choice (decision 9), so an expert caller's zone is never read.
 */
async function loadCallerZoneForInPlace(input: LoadCallNowGatesInput): Promise<string | null> {
  if (input.side !== 'client') {
    return null;
  }
  const timezoneContext = await usersRepository.findTimezoneContext(input.userId, undefined);
  return timezoneContext?.savedTimezone ?? 'UTC';
}

/** Is any meeting on the case, other than `excludeMeetingId`, live or inside its join window? */
function hasBookingStarting(
  caseMeetings: readonly CaseMeeting[],
  now: Date,
  excludeMeetingId: string | undefined
): boolean {
  return caseMeetings.some((meeting) => {
    if (meeting.id === excludeMeetingId) {
      return false;
    }
    if (meeting.status === 'in_progress' || meeting.status === 'waiting_for_participants') {
      return true;
    }
    return meeting.status === 'scheduled' && withinJoinWindow(now, meeting.scheduledStart);
  });
}

export async function loadCallNowGates(input: LoadCallNowGatesInput): Promise<CallNowGates> {
  const { caseRow, side, userId, now } = input;
  const presence = input.presence ?? offlineCalleePresence;

  const [expertSettings, ringingRing, otherLiveSession, caseMeetings, callerZone] =
    await Promise.all([
      expertsRepository.findResolverSettings(caseRow.expertProfileId),
      meetingRingsRepository.findRingingForEngagement(caseRow.id),
      companyHasOtherLiveSession(caseRow),
      meetingContextsRepository.listMeetingsForContext('case', caseRow.id),
      loadCallerZoneForInPlace(input),
    ]);
  const inPlaceCandidate =
    callerZone === null ? null : selectInPlaceCandidate(caseMeetings, now, callerZone);

  const calleeResult =
    expertSettings === null || !input.mayRing
      ? null
      : await resolveCallee({ caseRow, side, callerUserId: userId, expertSettings });
  const callee = calleeResult?.ok === true ? calleeResult : null;

  const [calleeInLiveMeeting, calleeOnline, calleeRecentlyDeclinedCaller] =
    callee === null
      ? [false, false, false]
      : await Promise.all([
          meetingPresenceRepository.isUserInLiveMeeting(callee.userId, now),
          presence.isOnline(callee.userId),
          meetingRingsRepository.hasDeclinedSince({
            callerUserId: userId,
            calleeUserId: callee.userId,
            since: new Date(now.getTime() - CALL_NOW_DECLINE_COOLDOWN_MS),
          }),
        ]);

  const expertTimeZone = expertSettings?.timezone ?? 'UTC';
  if (!isUsableTimeZone(expertTimeZone)) {
    log.warn(
      { engagementId: caseRow.id, timeZone: expertTimeZone },
      'Expert time zone is not a valid IANA zone — Call now fails closed on call hours'
    );
  }
  const expertWithinCallHours = isWithinCallHours(now, expertTimeZone);

  const availability = resolveCallNowAvailability({
    callerSide: side,
    caseOpen: caseRow.closedAt === null && caseRow.status === 'active',
    expertAvailableForWork: expertSettings?.availableForWork ?? false,
    calleeResolved: callee !== null,
    calleeRecentlyDeclinedCaller,
    calleeInLiveMeeting,
    ringLiveOnCase: ringingRing !== undefined && isRingLive(ringingRing, now),
    bookingStartingOnCase: hasBookingStarting(caseMeetings, now, ringingRing?.meetingId),
    companyHasOtherLiveSession: otherLiveSession,
    calleeOnline,
    expertWithinCallHours,
  });

  return {
    availability,
    callee: callee === null ? null : { userId: callee.userId, timeZone: callee.timeZone },
    inPlaceCandidate,
    expertProfileId: caseRow.expertProfileId,
    companyId: caseRow.companyId,
  };
}
