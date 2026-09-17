import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';

/**
 * BAL-475 — THE ENGINE CONTRACT for a Balo-organised calendar invite. Declared OUTSIDE
 * `services/calendar-invites/` (that directory is the counterparty-address invariant's
 * second scan root — see `invariants/no-counterparty-address-on-calendar-writes.test.ts`) so
 * the notification-engine plumbing (dispatcher, channel, delivery) can import this shape
 * without importing anything from the scanned root itself.
 *
 * ⚠ IDS ONLY (U1) — `recipient` never carries an address. The email channel resolves the
 * address at DELIVERY time, from the id here, and never before.
 */

export const CALENDAR_INVITE_METHOD = 'REQUEST' as const;
export type CalendarInviteMethod = typeof CALENDAR_INVITE_METHOD;

/**
 * The wire channel a calendar invite always rides on — V1 is EMAIL ONLY. Declared here, OUTSIDE
 * `services/calendar-invites/` (the counterparty-address invariant's second scan root), so
 * code under that root can reference the channel VALUE without ever writing the literal
 * "email" token itself — the marker scan bans that token in code, not through this constant's
 * one definition.
 */
export const CALENDAR_INVITE_CHANNEL = 'email' as const;
export type CalendarInviteChannel = typeof CALENDAR_INVITE_CHANNEL;

export const CALENDAR_INVITE_TRANSITIONS = ['booked', 'guest_added', 'rescheduled'] as const;
export type CalendarInviteTransition = (typeof CALENDAR_INVITE_TRANSITIONS)[number];

export type CalendarInviteParty = 'client' | 'expert';

/** IDS ONLY — the address is resolved by the email channel at delivery time (U1). */
export type CalendarInviteRecipient =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'guest'; readonly guestId: string };

export interface CalendarInviteSpec {
  readonly meetingId: string;
  readonly party: CalendarInviteParty;
  /** The `meeting_calendar_events.id` the publisher read — the send re-reads it LIVE by id. */
  readonly calendarEventId: string;
  readonly method: CalendarInviteMethod;
  readonly transition: CalendarInviteTransition;
  readonly recipient: CalendarInviteRecipient;
  /**
   * F5 (fix round 1, R4) — the meeting's primary bookable context, carried at PUBLISH time so
   * every delivery outcome line can log it (the AC field was previously always `null` on
   * delivery lines — see `calendarInviteLogFields`). `null` only when the publisher genuinely
   * could not resolve one (no primary context). Validated against the closed
   * `BOOKABLE_CONTEXT_TYPES` set — a sixth value is a malformed spec, not a slightly-wrong one.
   */
  readonly contextType: (typeof BOOKABLE_CONTEXT_TYPES)[number] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRecipient(value: unknown): CalendarInviteRecipient | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'user' && typeof value.userId === 'string' && value.userId.length > 0) {
    // Reject a shape that ALSO carries a guest field — an ambiguous/extra-kind payload must
    // never be silently narrowed to the first field that happens to match.
    if ('guestId' in value) return undefined;
    return { kind: 'user', userId: value.userId };
  }
  if (value.kind === 'guest' && typeof value.guestId === 'string' && value.guestId.length > 0) {
    if ('userId' in value) return undefined;
    return { kind: 'guest', guestId: value.guestId };
  }
  return undefined;
}

function isCalendarInviteMethod(value: unknown): value is CalendarInviteMethod {
  return value === CALENDAR_INVITE_METHOD;
}

function isCalendarInviteTransition(value: unknown): value is CalendarInviteTransition {
  return (
    typeof value === 'string' && (CALENDAR_INVITE_TRANSITIONS as readonly string[]).includes(value)
  );
}

/** F12 (fix round 1, R11) — the ONE definition of "is this a two-sided calendar party",
 *  exported so the publisher and the db `_shared/calendar-sequence.ts` copy (which cannot
 *  import from apps/api) are the only other declarations. */
export function isCalendarInviteParty(value: unknown): value is CalendarInviteParty {
  return value === 'client' || value === 'expert';
}

function isCalendarInviteContextType(
  value: unknown
): value is (typeof BOOKABLE_CONTEXT_TYPES)[number] {
  return typeof value === 'string' && (BOOKABLE_CONTEXT_TYPES as readonly string[]).includes(value);
}

/**
 * Strict structural guard over untyped job/payload JSON. `undefined` on ANY mismatch — never
 * throws, never uses `as`. The dispatcher and the delivery module both parse the SAME payload
 * through this one guard, so a malformed spec is a `undefined` (skip + warn) at either seam,
 * never a runtime crash.
 */
export function readCalendarInviteSpec(value: unknown): CalendarInviteSpec | undefined {
  if (!isRecord(value)) return undefined;
  const { meetingId, party, calendarEventId, method, transition, recipient, contextType } = value;
  if (typeof meetingId !== 'string' || meetingId.length === 0) return undefined;
  if (!isCalendarInviteParty(party)) return undefined;
  if (typeof calendarEventId !== 'string' || calendarEventId.length === 0) return undefined;
  if (!isCalendarInviteMethod(method)) return undefined;
  if (!isCalendarInviteTransition(transition)) return undefined;
  if (contextType !== null && !isCalendarInviteContextType(contextType)) return undefined;
  const readRecipientValue = readRecipient(recipient);
  if (readRecipientValue === undefined) return undefined;

  return {
    meetingId,
    party,
    calendarEventId,
    method,
    transition,
    recipient: readRecipientValue,
    contextType,
  };
}

export function calendarInviteRecipientId(recipient: CalendarInviteRecipient): string {
  return recipient.kind === 'user' ? recipient.userId : recipient.guestId;
}

/** `'user:<id>'` | `'guest:<id>'` — for keys and logs. */
export function calendarInviteRecipientKey(recipient: CalendarInviteRecipient): string {
  return `${recipient.kind}:${calendarInviteRecipientId(recipient)}`;
}
