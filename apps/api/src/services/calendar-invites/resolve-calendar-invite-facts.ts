import { meetingContextsRepository } from '@balo/db';
import { selectPrimaryMeetingContext } from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import {
  CALENDAR_CONTEXT_REGISTRY,
  type CalendarProjectedContextType,
} from '../consultation-events/calendar-context-registry.js';
import { memberJoinUrl } from '../consultation-events/member-join-url.js';
import { resolveExpertCalendarFacts } from '../consultation-events/resolve-calendar-facts.js';
import {
  deliveringExpertProfileIdForMeeting,
  deliveringPartyName,
} from '../meetings/delivering-party.js';
import type { CalendarInviteParty } from '../../notifications/calendar-invite-spec.js';
import {
  CALENDAR_INVITE_CHANGES_NOTE,
  CALENDAR_INVITE_GUEST_JOIN_NOTE,
} from '../../notifications/calendar-invite-copy.js';

/**
 * BAL-475 (O3) — the calendar-invite DISPLAY FACTS: re-resolved at SEND time, never snapshotted.
 * No display fact of this kind persists across a reschedule — only the row's `uid`/`sequence`
 * are durable state.
 */

export type CalendarInviteAudience = 'member' | 'guest';

export interface CalendarInviteFacts {
  readonly contextType: CalendarProjectedContextType;
  readonly summary: string;
  readonly description: string;
  /** MEMBER join URL; `undefined` for a guest (U4: no join link in a guest's ICS). */
  readonly location: string | undefined;
  /** The email CTA — the same value as `location` for a member; `undefined` for a guest. */
  readonly memberJoinUrl: string | undefined;
}

/**
 * BAL-475 (follow-up, F32) — the ONLY shape `resolveCalendarInviteFacts` throws for an upstream
 * read failure. Sanitised consistent with `CalendarInviteSendError`'s reasoning
 * (`calendar-invite-delivery.ts`, F2, fix round 1): carries the failing read's error NAME only,
 * never its message or a `cause` chain (Pino's `err` serializer walks `cause`, which would
 * silently reintroduce a leak).
 */
export class CalendarInviteFactsError extends Error {
  constructor(causeName: string) {
    super(`Calendar invite display facts resolution failed: ${causeName}`);
    this.name = 'CalendarInviteFactsError';
    Object.setPrototypeOf(this, CalendarInviteFactsError.prototype);
  }
}

/**
 * READ-SIDE NARROWING, NOT the deleted `isCalendarProjectedContext` projection gate. A meeting
 * that holds a calendar row was booked through a bookable context by construction; a
 * non-bookable primary context here is drift, and yields no facts (skip) rather than a guessed
 * label.
 */
function hasCalendarDescriptor(label: string): label is CalendarProjectedContextType {
  return Object.hasOwn(CALENDAR_CONTEXT_REGISTRY, label);
}

function buildDescription(
  audience: CalendarInviteAudience,
  title: string,
  memberUrl: string | undefined
): string {
  const joinLine =
    audience === 'member' ? `Join: ${memberUrl ?? ''}` : CALENDAR_INVITE_GUEST_JOIN_NOTE;
  return `${title}\n\n${joinLine}\n\n${CALENDAR_INVITE_CHANGES_NOTE}`;
}

/**
 * `undefined` is returned ONLY for genuine domain absence — no primary context, a primary
 * context that isn't calendar-projected/bookable, or `resolveExpertCalendarFacts` itself
 * reporting no live facts. Every one of those is a terminal business fact a retry cannot change,
 * so the delivery job's `no_display_facts` skip stays meaningful and non-retryable.
 *
 * BAL-475 (follow-up, F32) — on a THROWN error (a DB read blip, etc.) this now logs it exactly
 * as before (message + stack) and THEN RETHROWS a sanitised {@link CalendarInviteFactsError}
 * (never the raw error) so the caller's promise rejects and BullMQ retries. Previously every
 * failure — thrown or not — degraded to `undefined`, which meant a single transient read failure
 * silently and PERMANENTLY dropped that recipient's calendar invite (the delivery job "succeeded"
 * with nothing sent, no Sentry event, no retry). This is the ONLY caller of
 * `resolveExpertCalendarFacts` that must behave this way — that function's OTHER caller (the
 * post-commit, best-effort expert-calendar projection) genuinely cannot retry and correctly keeps
 * its own "never throws" contract; it is untouched by this fix.
 */
export async function resolveCalendarInviteFacts(
  input: {
    readonly meetingId: string;
    readonly party: CalendarInviteParty;
    readonly audience: CalendarInviteAudience;
  },
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<CalendarInviteFacts | undefined> {
  const { meetingId, party, audience } = input;

  try {
    const contexts = await meetingContextsRepository.listByMeeting(meetingId);
    const primary = selectPrimaryMeetingContext(contexts);
    if (!primary.ok) {
      log.info(
        { meetingId, party, audience },
        'No primary context — skipping calendar invite facts'
      );
      return undefined;
    }
    const { contextType, contextId } = primary.context;
    if (!hasCalendarDescriptor(contextType)) {
      log.warn(
        { meetingId, party, audience, contextType },
        'Primary context is not a calendar-projected context — skipping calendar invite facts'
      );
      return undefined;
    }

    const facts = await resolveExpertCalendarFacts({ meetingId, contextType, contextId }, log);
    if (facts === undefined) {
      return undefined;
    }

    const joinUrl = memberJoinUrl(meetingId);

    let summary: string;
    if (party === 'expert') {
      // ADR-1044 §4: names the client COMPANY, byte-identical to the provider event's title.
      summary = `${facts.eventLabel} with ${facts.clientCompanyName}`;
    } else {
      const deliveringProfileId = await deliveringExpertProfileIdForMeeting(meetingId);
      const partyName = await deliveringPartyName(deliveringProfileId);
      summary = `${facts.eventLabel} with ${partyName ?? 'your expert'}`;
    }

    const description = buildDescription(audience, facts.title, joinUrl);
    const location = audience === 'member' ? joinUrl : undefined;

    return {
      contextType,
      summary,
      description,
      location,
      memberJoinUrl: audience === 'member' ? joinUrl : undefined,
    };
  } catch (error) {
    log.error(
      {
        meetingId,
        party,
        audience,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Failed to resolve calendar invite display facts'
    );
    // BAL-475 (follow-up, F32) — RETHROW, sanitised. This used to `return undefined`, which the
    // delivery job's Step 6 treats identically to genuine domain absence: a terminal
    // `no_display_facts` skip. That silently and permanently dropped the invite on a transient
    // read failure instead of letting BullMQ retry (`attempts: 3`). Nothing has been claimed yet
    // at this point in the delivery path, so throwing here is safe to retry from scratch.
    throw new CalendarInviteFactsError(error instanceof Error ? error.name : 'UnknownError');
  }
}
