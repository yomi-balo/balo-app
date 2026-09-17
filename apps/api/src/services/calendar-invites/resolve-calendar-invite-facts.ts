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
 * NEVER THROWS — `undefined` on any failure (logged).
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
    return undefined;
  }
}
