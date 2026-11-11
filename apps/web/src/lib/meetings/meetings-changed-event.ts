import type { BellNotification } from '@/components/balo/notification-arrival';

/**
 * The window event the notification feed raises when a poll carries a meeting-affecting
 * notification it has not seen before. The top-nav call pill listens for it and refetches, so a
 * booking, a reschedule or a cancellation shows up without waiting for the next visit trigger.
 * The feed is only a refetch trigger — it never carries meeting data.
 */
export const MEETINGS_CHANGED_EVENT = 'balo:meetings-changed';

/** The notification event namespaces (the segment before the first `.`) that change a join window. */
export const MEETING_CHANGE_NAMESPACES = ['booking', 'reschedule_proposal', 'meeting'] as const;

/**
 * Exact events outside those namespaces that also change a call. `conversation.intro_call_booked`
 * covers every call booked from a request page; `project.kickoff_approved` re-anchors the request's
 * calls onto the new engagement, which changes their type and link. The rest of those namespaces
 * (messages, files, proposals) does not touch a call, so neither namespace is listed.
 */
export const MEETING_CHANGE_EVENTS = [
  'conversation.intro_call_booked',
  'project.kickoff_approved',
] as const;

export function isMeetingChangeNotification(event: string): boolean {
  if ((MEETING_CHANGE_EVENTS as readonly string[]).includes(event)) return true;
  const [namespace = ''] = event.split('.');
  return (MEETING_CHANGE_NAMESPACES as readonly string[]).includes(namespace);
}

/**
 * True when `notifications` holds a meeting-change notification whose id is not in `known`.
 * `known === null` is the first load, which only seeds the known set: a booking that landed
 * before this page opened is already in the pill's own first fetch.
 */
export function hasNewMeetingChange(
  known: ReadonlySet<string> | null,
  notifications: readonly Pick<BellNotification, 'id' | 'event'>[]
): boolean {
  if (known === null) return false;
  return notifications.some((n) => !known.has(n.id) && isMeetingChangeNotification(n.event));
}

export function dispatchMeetingsChanged(): void {
  globalThis.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT));
}
