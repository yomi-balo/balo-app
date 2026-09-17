import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { render } from '@react-email/render';
import {
  meetingCalendarDeliveriesRepository,
  meetingCalendarEventsRepository,
  meetingGuestsRepository,
  meetingsRepository,
  usersRepository,
  type Meeting,
  type MeetingCalendarEvent,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { guestIsAdmittedForRead, sanitizeSelfDeclaredName } from '@balo/shared/meetings';
import type { SendMailOptions } from 'nodemailer';
import {
  CALENDAR_INVITE_METHOD,
  readCalendarInviteSpec,
  type CalendarInviteSpec,
} from '../calendar-invite-spec.js';
import { deliveringExpertProfileIdForMeeting } from '../../services/meetings/delivering-party.js';
import { buildCalendarInviteIcs } from '../../services/calendar-invites/build-calendar-invite-ics.js';
import { calendarInviteLogFields } from '../../services/calendar-invites/log-fields.js';
import { resolveCalendarPartyMemberUserIds } from '../../services/calendar-invites/resolve-calendar-invite-recipients.js';
import {
  resolveCalendarInviteFacts,
  type CalendarInviteAudience,
  type CalendarInviteFacts,
} from '../../services/calendar-invites/resolve-calendar-invite-facts.js';
import { buildCalendarInviteMailOptions } from './calendar-invite-message.js';
import { logNotification } from './log.js';
import { getEmailTemplate } from './templates/index.js';
import type { DeliveryPayload } from './types.js';

/**
 * BAL-475 — the SECOND transport delivery path of the email channel. This is the ONE
 * sanctioned domain read inside the email channel: U1 requires the recipient's address to be
 * resolved HERE, at delivery time, and never carried in a payload.
 *
 * ⚠ STEP ORDER IS LOAD-BEARING (§4.5 point 3): the row (SEQUENCE) is read BEFORE the meeting
 * (window). Because the SEQUENCE bump and the window move commit atomically inside
 * `updateSchedule`'s transaction, a window read after the sequence read is always at least as
 * new as that sequence — never an old window at a new sequence. F4 (fix round 1, R3) split this
 * function into `resolveCalendarInviteTarget` / `loadSendableState` / `sendClaimedInvite` to
 * bring its cognitive complexity under the repo's Sonar limit, WITHOUT moving a single step out
 * of order — `loadSendableState` still reads the row before the meeting.
 *
 * ⚠ EVERY NON-SEND EXIT IS A `skip` — logs the outcome, writes the ledger's skip audit via
 * `logNotification`, and RETURNS. Never throws for a skip: BullMQ must not retry a delivery
 * that can never succeed.
 *
 * ⚠ F2 (fix round 1, R2/S1) — THE TRANSPORT ERROR IS NEVER RETHROWN. nodemailer's own error
 * messages can (and, per the security review's live probe against a fake SMTP server, DO)
 * embed the recipient's address on an RCPT rejection. `describeSmtpFailure` already extracts
 * only class/code/responseCode for the log and the ledger's `failure_reason`; the THROW must
 * carry the same sanitised shape, via `CalendarInviteSendError`, or the raw address reaches
 * Axiom (via the BullMQ `failed` handler) and Redis's retained `failedReason` regardless of
 * how careful the log lines are.
 */

const log = createLogger('calendar-invite-delivery');

export interface CalendarInviteTransport {
  readonly organizerAddress: string;
  send(options: SendMailOptions): Promise<{ messageId: string | null }>;
}

/**
 * F2 (fix round 1, R2/S1) — the ONLY shape `deliverCalendarInvite` ever throws for a transport
 * failure. Carries class/code/responseCode ONLY — never the original error, never a `cause`
 * (Pino's `err` serializer walks `cause`, which would silently reintroduce the leak this class
 * exists to close).
 */
export class CalendarInviteSendError extends Error {
  readonly code: string | null;
  readonly responseCode: number | null;

  constructor(failureReason: string, code: string | null, responseCode: number | null) {
    super(`Calendar invite SMTP send failed: ${failureReason}`);
    this.name = 'CalendarInviteSendError';
    this.code = code;
    this.responseCode = responseCode;
    Object.setPrototypeOf(this, CalendarInviteSendError.prototype);
  }
}

/** Class + SMTP code only — SMTP replies can echo addresses, so the message is never logged or persisted. */
export function describeSmtpFailure(error: unknown): {
  name: string;
  code: string | null;
  responseCode: number | null;
  command: string | null;
} {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', code: null, responseCode: null, command: null };
  }
  const withCode = error as Error & {
    code?: unknown;
    responseCode?: unknown;
    command?: unknown;
  };
  return {
    name: error.name,
    code: typeof withCode.code === 'string' ? withCode.code : null,
    responseCode: typeof withCode.responseCode === 'number' ? withCode.responseCode : null,
    command: typeof withCode.command === 'string' ? withCode.command : null,
  };
}

/** Widen a `CalendarInviteLogFields` value to the plain index-signature shape Sentry's `extra` wants. */
function toExtras(fields: ReturnType<typeof calendarInviteLogFields>): Record<string, unknown> {
  return { ...fields };
}

type CalendarInviteSkipReason =
  | 'calendar_class_with_attachments'
  | 'smtp_not_configured'
  | 'no_address'
  | 'recipient_not_member'
  | 'guest_not_admitted'
  | 'calendar_event_not_live'
  | 'provider_event_party'
  | 'meeting_not_live'
  | 'no_display_facts'
  | 'no_job_id'
  | 'duplicate_suppressed'
  | 'in_flight_elsewhere';

/** Every non-send exit: audit the skip, log the ONE outcome line, and return — never throw. */
async function skip(input: {
  readonly logPayload: DeliveryPayload;
  readonly spec: CalendarInviteSpec;
  readonly contextType: string | null;
  readonly sequence: number | null;
  readonly reason: CalendarInviteSkipReason;
  readonly level?: 'info' | 'warn' | 'error';
}): Promise<void> {
  await logNotification(input.logPayload, 'email', 'skipped', input.reason);
  const fields = calendarInviteLogFields({
    spec: input.spec,
    contextType: input.contextType,
    sequence: input.sequence,
  });
  const level = input.level ?? 'info';
  log[level](
    { ...fields, outcome: 'skipped', reason: input.reason },
    'Calendar invite delivery outcome'
  );
}

type TargetResolution =
  | {
      readonly ok: true;
      readonly recipientAddress: string;
      readonly recipientName: string;
      readonly audience: CalendarInviteAudience;
      readonly logPayload: DeliveryPayload;
    }
  | { readonly ok: false; readonly reason: CalendarInviteSkipReason };

/**
 * Step 2 — resolve the recipient. THE FIRST place an address exists.
 *
 * ⚠ F23 (fix round 1, S3) — FOR A USER RECIPIENT, THE MEMBERSHIP RE-CHECK RUNS BEFORE ANY
 * ADDRESS IS RESOLVED. U2/P4 ("booker must still hold `participate`"; "delivering expert
 * only") were previously enforced ONLY at publish time — a booker removed from the company (or
 * any other well-formed `userId` a spec might name) between publish and send would still get
 * the meeting's window, counterparty name and member join URL. Re-running
 * `resolveCalendarPartyMemberUserIds` here — the SAME resolver the publisher already uses —
 * puts users and guests (already send-time re-checked) under one send-time rule.
 */
async function resolveCalendarInviteTarget(
  spec: CalendarInviteSpec,
  payload: DeliveryPayload
): Promise<TargetResolution> {
  if (spec.recipient.kind === 'user') {
    const expertProfileId = await deliveringExpertProfileIdForMeeting(spec.meetingId);
    const memberUserIds = await resolveCalendarPartyMemberUserIds({
      meetingId: spec.meetingId,
      party: spec.party,
      expertProfileId,
    });
    if (!memberUserIds.includes(spec.recipient.userId)) {
      return { ok: false, reason: 'recipient_not_member' };
    }

    const user = await usersRepository.findById(spec.recipient.userId);
    if (user?.email === undefined || user.email === null) {
      return { ok: false, reason: 'no_address' };
    }
    return {
      ok: true,
      recipientAddress: user.email,
      recipientName: user.firstName ?? 'there',
      audience: 'member',
      logPayload: payload,
    };
  }

  const guest = await meetingGuestsRepository.findLiveById(spec.meetingId, spec.recipient.guestId);
  if (
    guest === undefined ||
    guest.party !== spec.party ||
    !guestIsAdmittedForRead(guest.admission)
  ) {
    // ⚠ NO ADDRESS IN THE LOG PAYLOAD — a `pending` knock is anonymous input.
    return { ok: false, reason: 'guest_not_admitted' };
  }
  return {
    ok: true,
    recipientAddress: guest.email,
    recipientName:
      guest.name === null ? 'there' : (sanitizeSelfDeclaredName(guest.name) ?? 'there'),
    audience: 'guest',
    logPayload: { ...payload, recipientEmail: guest.email },
  };
}

type SendableState =
  | {
      readonly ok: true;
      readonly row: MeetingCalendarEvent;
      readonly meeting: Meeting;
      readonly facts: CalendarInviteFacts;
    }
  | {
      readonly ok: false;
      readonly reason: CalendarInviteSkipReason;
      readonly sequence: number | null;
    };

/**
 * Steps 3-6 — the LIVE calendar row (read BEFORE the meeting), Ruling 1's re-check, the
 * meeting's liveness (F30: `cancelled` OR `ended`), and the display facts. Order preserved
 * exactly from the pre-split function; M9's ordering test pins it.
 */
async function loadSendableState(
  spec: CalendarInviteSpec,
  audience: CalendarInviteAudience
): Promise<SendableState> {
  // Step 3 — the LIVE calendar row, SCOPED to (id, meetingId, party) since F24 (fix round 1,
  // S4). Read the row (SEQUENCE) BEFORE the meeting (window).
  const row = await meetingCalendarEventsRepository.findLiveById({
    id: spec.calendarEventId,
    meetingId: spec.meetingId,
    party: spec.party,
  });
  if (row === undefined) {
    return { ok: false, reason: 'calendar_event_not_live', sequence: null };
  }
  // F24 — the WHERE above already scopes by (meetingId, party); this is now a structurally
  // guaranteed no-op, kept as a cheap defence-in-depth assertion rather than removed outright.
  if (row.meetingId !== spec.meetingId || row.party !== spec.party) {
    return { ok: false, reason: 'calendar_event_not_live', sequence: null };
  }

  // Step 4 — Ruling 1, re-checked at send: never both a provider event AND an ICS.
  if (spec.recipient.kind === 'user' && spec.party === 'expert' && row.deliveryMode !== 'ics') {
    return { ok: false, reason: 'provider_event_party', sequence: row.sequence };
  }

  // Step 5 — the meeting must still be live. F30 (fix round 1, tech follow-up): `ended` is a
  // skip alongside `cancelled` — a very late job must never REQUEST an invite for a past call.
  // METHOD:CANCEL is BAL-476's.
  const meeting = await meetingsRepository.findById(spec.meetingId);
  if (meeting === undefined || meeting.status === 'cancelled' || meeting.status === 'ended') {
    return { ok: false, reason: 'meeting_not_live', sequence: row.sequence };
  }

  // Step 6 — display facts, re-resolved at send time (O3).
  const facts = await resolveCalendarInviteFacts(
    { meetingId: spec.meetingId, party: spec.party, audience },
    log
  );
  if (facts === undefined) {
    return { ok: false, reason: 'no_display_facts', sequence: row.sequence };
  }

  return { ok: true, row, meeting, facts };
}

/**
 * Step 10 — claim then send. Both nested try/catches (markSent's own DB-failure catch; the
 * outer send-failure catch) preserved verbatim from the pre-split function.
 */
async function sendClaimedInvite(input: {
  readonly job: Job<DeliveryPayload>;
  readonly transport: CalendarInviteTransport;
  readonly spec: CalendarInviteSpec;
  readonly row: MeetingCalendarEvent;
  /** F5 (fix round 1, R4) — `facts.contextType`, resolved at step 6; carried through so every
   *  outcome line from here on logs it, never the publish-time `spec.contextType`. */
  readonly contextType: string;
  readonly logPayload: DeliveryPayload;
  readonly claimToken: string;
  readonly options: SendMailOptions;
}): Promise<void> {
  const { job, transport, spec, row, contextType, logPayload, claimToken, options } = input;

  const claim = await meetingCalendarDeliveriesRepository.claimSend({
    calendarEventId: row.id,
    recipient: spec.recipient,
    sequence: row.sequence,
    method: CALENDAR_INVITE_METHOD,
    channel: 'email',
    claimToken,
  });
  if (claim.status === 'already_sent') {
    await skip({
      logPayload,
      spec,
      contextType,
      sequence: row.sequence,
      reason: 'duplicate_suppressed',
    });
    return;
  }
  if (claim.status === 'in_flight') {
    await skip({
      logPayload,
      spec,
      contextType,
      sequence: row.sequence,
      reason: 'in_flight_elsewhere',
    });
    return;
  }

  try {
    const info = await transport.send(options);
    try {
      const marked = await meetingCalendarDeliveriesRepository.markSent({
        id: claim.delivery.id,
        claimToken,
        providerMessageId: info.messageId,
      });
      if (marked === undefined) {
        log.warn(
          calendarInviteLogFields({ spec, contextType, sequence: row.sequence }),
          'Calendar invite sent, but its claim was taken over before markSent'
        );
      }
    } catch (dbError) {
      log.error(
        {
          ...calendarInviteLogFields({ spec, contextType, sequence: row.sequence }),
          error: dbError instanceof Error ? dbError.message : String(dbError),
        },
        'Calendar invite sent, but markSent failed'
      );
      Sentry.captureException(dbError);
    }

    await logNotification(logPayload, 'email', 'sent', undefined, {
      smtpMessageId: info.messageId,
      calendarEventId: row.id,
      sequence: row.sequence,
      method: CALENDAR_INVITE_METHOD,
      transition: spec.transition,
    });
    const fields = calendarInviteLogFields({ spec, contextType, sequence: row.sequence });
    log.info(
      { ...fields, outcome: 'sent', smtpMessageId: info.messageId },
      'Calendar invite delivery outcome'
    );
  } catch (error) {
    const failure = describeSmtpFailure(error);
    const failureReason = [failure.name, failure.code, failure.responseCode]
      .filter((part): part is string | number => part !== null)
      .join(':');

    try {
      await meetingCalendarDeliveriesRepository.markFailed({
        id: claim.delivery.id,
        claimToken,
        failureReason,
      });
    } catch (dbError) {
      log.error(
        {
          ...calendarInviteLogFields({ spec, contextType, sequence: row.sequence }),
          error: dbError instanceof Error ? dbError.message : String(dbError),
        },
        'Calendar invite send failed, and markFailed also failed'
      );
      Sentry.captureException(dbError);
    }

    await logNotification(logPayload, 'email', 'failed', failureReason);
    const fields = calendarInviteLogFields({ spec, contextType, sequence: row.sequence });
    log.error({ ...fields, outcome: 'failed', ...failure }, 'Calendar invite delivery outcome');

    // F2 (fix round 1, R2/S1) — the SANITISED error, never `error` itself. `error`'s own
    // message can carry the recipient's address (a proven, live-probed nodemailer behaviour on
    // an RCPT rejection); `failureReason` is class:code:responseCode only.
    const sanitizedError = new CalendarInviteSendError(
      failureReason,
      failure.code,
      failure.responseCode
    );

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) {
      Sentry.captureException(sanitizedError, { extra: toExtras(fields) });
    }

    throw sanitizedError;
  }
}

/**
 * Deliver ONE calendar invite. Never sends anything but a calendar-class message. Never
 * throws for a skip; throws on a transport failure (always a sanitised `CalendarInviteSendError`
 * — F2) or a transient read/claim failure (F14 corrects the docblock that used to claim
 * otherwise) — so BullMQ retries.
 */
export async function deliverCalendarInvite(
  job: Job<DeliveryPayload>,
  transport: CalendarInviteTransport | undefined,
  now: () => Date = () => new Date()
): Promise<void> {
  const payload = job.data;
  const spec = readCalendarInviteSpec(payload.calendarInvite);
  if (spec === undefined) {
    log.error(
      { template: payload.template, event: payload.event },
      'deliverCalendarInvite called without a valid calendarInvite spec'
    );
    return;
  }

  // Step 0 — a calendar-class message must never carry another attachment (type-level AND
  // runtime guard: BullMQ job data is untyped JSON at runtime).
  if (payload.attachments !== undefined && payload.attachments.length > 0) {
    const fields = calendarInviteLogFields({ spec, contextType: spec.contextType, sequence: null });
    log.error(fields, 'Calendar-class message carried other attachments — refusing to send');
    Sentry.captureMessage('Calendar-class message carried other attachments', {
      level: 'error',
      extra: toExtras(fields),
    });
    await skip({
      logPayload: payload,
      spec,
      contextType: spec.contextType,
      sequence: null,
      reason: 'calendar_class_with_attachments',
    });
    return;
  }

  // Step 1 — SMTP unconfigured.
  if (transport === undefined) {
    const fields = calendarInviteLogFields({ spec, contextType: spec.contextType, sequence: null });
    if (process.env.NODE_ENV === 'production') {
      log.error(fields, 'Calendar invite SMTP relay is not configured');
      Sentry.captureMessage('Calendar invite SMTP relay is not configured', {
        level: 'error',
        extra: toExtras(fields),
      });
    } else {
      log.warn(fields, 'Calendar invite SMTP relay is not configured');
    }
    await skip({
      logPayload: payload,
      spec,
      contextType: spec.contextType,
      sequence: null,
      reason: 'smtp_not_configured',
    });
    return;
  }

  const target = await resolveCalendarInviteTarget(spec, payload);
  if (!target.ok) {
    await skip({
      logPayload: payload,
      spec,
      contextType: spec.contextType,
      sequence: null,
      reason: target.reason,
    });
    return;
  }
  const { recipientAddress, recipientName, audience, logPayload } = target;

  const state = await loadSendableState(spec, audience);
  if (!state.ok) {
    await skip({
      logPayload,
      spec,
      contextType: spec.contextType,
      sequence: state.sequence,
      reason: state.reason,
    });
    return;
  }
  const { row, meeting, facts } = state;

  // Step 7 — build the ICS.
  const ics = buildCalendarInviteIcs({
    uid: row.uid,
    sequence: row.sequence,
    summary: facts.summary,
    description: facts.description,
    location: facts.location,
    startAt: meeting.scheduledStart,
    endAt: meeting.scheduledEnd,
    stampAt: now(),
    organizerAddress: transport.organizerAddress,
    recipientAddress,
  });

  // Step 8 — render the accompanying email body.
  const { component, subject } = getEmailTemplate('meeting-calendar-invite', {
    recipientName,
    summary: facts.summary,
    startIso: meeting.scheduledStart.toISOString(),
    endIso: meeting.scheduledEnd.toISOString(),
    transition: spec.transition,
    audience,
    memberJoinUrl: facts.memberJoinUrl,
  });
  const html = await render(component);
  const text = await render(component, { plainText: true });
  const options = buildCalendarInviteMailOptions({
    organizerAddress: transport.organizerAddress,
    recipientAddress,
    recipientName,
    subject,
    html,
    text,
    ics,
  });

  // Step 9 — claim, IMMEDIATELY before sending.
  const claimToken = job.id;
  if (claimToken === undefined) {
    log.error(
      calendarInviteLogFields({ spec, contextType: facts.contextType, sequence: row.sequence }),
      'Calendar invite job has no id'
    );
    await skip({
      logPayload,
      spec,
      contextType: facts.contextType,
      sequence: row.sequence,
      reason: 'no_job_id',
    });
    return;
  }

  // Step 10 — claim + send.
  await sendClaimedInvite({
    job,
    transport,
    spec,
    row,
    contextType: facts.contextType,
    logPayload,
    claimToken,
    options,
  });
}
