import type { IncomingCallView } from '@/lib/call-now/call-now-types';
import type { BellNotification } from '../notification-arrival';

/** How long a pending-missed toast waits for its `call.no_answer` row before it gives up. */
export const PENDING_MISSED_GRACE_MS = 15_000;

/** The ringing view: the live ring, exactly as the loader shaped it. */
export interface RingingToastView {
  mode: 'ringing';
  ringId: string;
  meetingId: string;
  engagementId: string;
  lens: IncomingCallView['lens'];
  callerLabel: string;
  caseTitle: string | null;
  rateLine: string | null;
  awaitsAnswer: boolean;
  joinPath: string;
  expiresAtIso: string;
}

/**
 * The missed view. `rowIds` is every unread `call.no_answer` row the toast stands for (empty while
 * pending). A legacy row has no `callerLabel`, so the toast falls back to the row's own
 * `fallbackTitle` / `fallbackBody`.
 */
export interface MissedToastView {
  mode: 'missed';
  /** Stable for the toast's content: a change re-announces it. */
  key: string;
  rowIds: readonly string[];
  count: number;
  callerLabel: string | null;
  /** When the newest missed call started, or `null` for a legacy row. */
  startedAt: string | null;
  engagementId: string | null;
  fallbackTitle: string | null;
  fallbackBody: string | null;
  ringId: string | null;
  /** Built from the cached ring while its row has not arrived yet. */
  pending: boolean;
}

export type CallToastView = RingingToastView | MissedToastView;

export interface SelectCallToastInput {
  incoming: IncomingCallView | null;
  pendingMissed: IncomingCallView | null;
  rows: readonly BellNotification[];
  nowMs: number;
  declinedRingIds: ReadonlySet<string>;
  dismissedRingIds: ReadonlySet<string>;
}

const CASE_PATH = /^\/cases\/([^/?#]+)/;

/** The engagement id of a `/cases/{id}` action url, or `null`. */
export function engagementIdFromActionUrl(actionUrl: string | null): string | null {
  if (actionUrl === null) return null;
  return CASE_PATH.exec(actionUrl)?.[1] ?? null;
}

function newestFirst(a: BellNotification, b: BellNotification): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);
}

function isUnreadMissed(row: BellNotification): boolean {
  return row.event === 'call.no_answer' && row.readAt === null;
}

/**
 * The unread missed rows that belong in one toast: the newest row, plus every other unread row
 * from the SAME caller. A row without a `callerUserId` (legacy) is never grouped, so the toast
 * stands for that row alone. Different callers never merge: the older caller's rows wait.
 */
export function groupMissedRows(rows: readonly BellNotification[]): BellNotification[] {
  const [newest, ...rest] = rows.filter(isUnreadMissed).sort(newestFirst);
  if (newest === undefined) return [];
  const callerUserId = newest.call?.callerUserId ?? null;
  if (callerUserId === null) return [newest];
  return [newest, ...rest.filter((row) => row.call?.callerUserId === callerUserId)];
}

function missedFromRows(group: readonly BellNotification[]): MissedToastView | null {
  const [newest] = group;
  if (newest === undefined) return null;
  const labelled = newest.call?.callerLabel ?? null;
  return {
    mode: 'missed',
    key: `rows:${group.map((row) => row.id).join(',')}`,
    rowIds: group.map((row) => row.id),
    count: group.length,
    callerLabel: labelled,
    startedAt: newest.call?.startedAt ?? newest.createdAt,
    engagementId: engagementIdFromActionUrl(newest.actionUrl),
    fallbackTitle: labelled === null ? newest.title : null,
    fallbackBody: labelled === null ? newest.body : null,
    ringId: newest.call?.ringId ?? null,
    pending: false,
  };
}

function missedFromPending(view: IncomingCallView): MissedToastView {
  return {
    mode: 'missed',
    key: `pending:${view.ringId}`,
    rowIds: [],
    count: 1,
    callerLabel: view.callerLabel,
    startedAt: view.startedAtIso,
    engagementId: view.engagementId,
    fallbackTitle: null,
    fallbackBody: null,
    ringId: view.ringId,
    pending: true,
  };
}

function ringingFrom(view: IncomingCallView): RingingToastView {
  return {
    mode: 'ringing',
    ringId: view.ringId,
    meetingId: view.meetingId,
    engagementId: view.engagementId,
    lens: view.lens,
    callerLabel: view.callerLabel,
    caseTitle: view.caseTitle,
    rateLine: view.rateLine,
    awaitsAnswer: view.awaitsAnswer,
    joinPath: view.joinPath,
    expiresAtIso: view.expiresAtIso,
  };
}

/**
 * The one toast to show, by precedence:
 *
 *  1. RINGING — the live ring, until its `expiresAt` or while it is not declined.
 *  2. MISSED — the unread `call.no_answer` rows, newest first, grouped by caller (see
 *     {@link groupMissedRows}). Rows of a ring the viewer declined or dismissed are skipped.
 *  3. PENDING-MISSED — the cached ring that has just lapsed, until its row arrives. It never
 *     appears for a declined or dismissed ring, nor once any `call.no_answer` row for that ring
 *     exists (read or not: a read row means someone already dealt with it).
 */
export function selectCallToast(input: Readonly<SelectCallToastInput>): CallToastView | null {
  const { incoming, pendingMissed, rows, nowMs, declinedRingIds, dismissedRingIds } = input;

  if (
    incoming !== null &&
    nowMs < Date.parse(incoming.expiresAtIso) &&
    !declinedRingIds.has(incoming.ringId)
  ) {
    return ringingFrom(incoming);
  }

  const skipped = (ringId: string | null | undefined): boolean =>
    ringId !== null &&
    ringId !== undefined &&
    (declinedRingIds.has(ringId) || dismissedRingIds.has(ringId));
  const missed = missedFromRows(groupMissedRows(rows.filter((row) => !skipped(row.call?.ringId))));
  if (missed !== null) return missed;

  if (pendingMissed === null || skipped(pendingMissed.ringId)) return null;
  const rowExists = rows.some(
    (row) => row.event === 'call.no_answer' && row.call?.ringId === pendingMissed.ringId
  );
  return rowExists ? null : missedFromPending(pendingMissed);
}
