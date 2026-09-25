import { dailyRoomNameForMeeting } from './room-name';

/** What caused a provisioning attempt. Analytics `trigger`. */
export const MEETING_PROVISION_TRIGGERS = ['booking', 'replay', 'repair'] as const;
export type MeetingProvisionTrigger = (typeof MEETING_PROVISION_TRIGGERS)[number];

/** The three meeting columns venue readiness reads. Never the whole row. */
export interface MeetingVenueFields {
  readonly id: string;
  readonly dailyRoomName: string | null;
  readonly joinUrl: string | null;
}

/** A venue that passed {@link isMeetingVenueReady}. */
export type ReadyMeetingVenue = { readonly dailyRoomName: string; readonly joinUrl: string };

/**
 * THE ONE DEFINITION of "this meeting's call room exists and is ours": both columns stamped AND
 * the stamped name equals `dailyRoomNameForMeeting(id)`. Exactly `resolveVenue`'s semantics
 * (join-meeting.ts). Used on FULL rows (the join path, provisioning, the lifecycle sweep, the
 * absence recheck, `load-case.ts`). Its SQL twin is `meetingVenueReadySql` in
 * `repositories/meetings.ts` — the repair/finder read and the three LIST reads compute `roomReady`
 * with it, so a list surface never selects the join credential — pinned to this
 * function by `meetings.integration.test.ts`.
 * A type predicate so callers narrow `dailyRoomName`/`joinUrl` to `string`.
 */
export function isMeetingVenueReady<T extends MeetingVenueFields>(
  meeting: T
): meeting is T & ReadyMeetingVenue {
  // `typeof … === 'string'`, not `!== null`: identical for every real row (Drizzle maps SQL NULL
  // to `null`), and an untyped test fixture that OMITS a column reads as "not ready" instead of
  // slipping through as `undefined !== null`.
  return (
    typeof meeting.dailyRoomName === 'string' &&
    typeof meeting.joinUrl === 'string' &&
    meeting.dailyRoomName === dailyRoomNameForMeeting(meeting.id)
  );
}

export interface MeetingVenueStampFields extends MeetingVenueFields {
  readonly venueProvisionedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * When the venue BECAME ready, or `null` while it is not ready.
 * ⚠ A ready row with a NULL stamp falls back to `createdAt`: the rolling-deploy window in
 * which an older build's `setVenue` stamps a room without the column, `meetingsRepository.create()`'s
 * inline-venue path (a creation-time stamp that never writes the column), and the backfill's own rule.
 */
export function meetingVenueReadyAt(meeting: MeetingVenueStampFields): Date | null {
  if (!isMeetingVenueReady(meeting)) return null;
  return meeting.venueProvisionedAt ?? meeting.createdAt;
}
