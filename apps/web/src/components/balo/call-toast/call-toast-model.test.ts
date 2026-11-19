import { describe, it, expect } from 'vitest';
import type { IncomingCallView } from '@/lib/call-now/call-now-types';
import type { BellCallMeta, BellNotification } from '../notification-arrival';
import {
  engagementIdFromActionUrl,
  groupMissedRows,
  selectCallToast,
  type SelectCallToastInput,
} from './call-toast-model';

const NOW = Date.parse('2026-11-19T10:00:00.000Z');
const FUTURE = '2026-11-19T10:00:30.000Z';
const PAST = '2026-11-19T09:59:59.000Z';

function ring(overrides: Partial<IncomingCallView> = {}): IncomingCallView {
  return {
    ringId: 'ring-1',
    meetingId: 'meeting-1',
    engagementId: 'eng-1',
    lens: 'client',
    callerLabel: 'Sandy',
    caseTitle: 'Flow migration',
    rateLine: 'From A$2.00/min · 15-minute minimum',
    expiresAtIso: FUTURE,
    startedAtIso: '2026-11-19T09:59:30.000Z',
    awaitsAnswer: true,
    joinPath: '/meetings/meeting-1/call',
    serverNowIso: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function missed(
  id: string,
  createdAt: string,
  call: Partial<BellCallMeta> | null,
  overrides: Partial<BellNotification> = {}
): BellNotification {
  return {
    id,
    event: 'call.no_answer',
    title: `Missed call ${id}`,
    body: 'legacy body',
    actionUrl: '/cases/eng-1',
    readAt: null,
    createdAt,
    call:
      call === null
        ? null
        : { ringId: null, callerUserId: null, callerLabel: null, startedAt: null, ...call },
    ...overrides,
  };
}

function select(input: Partial<SelectCallToastInput> = {}): ReturnType<typeof selectCallToast> {
  return selectCallToast({
    incoming: null,
    pendingMissed: null,
    rows: [],
    nowMs: NOW,
    declinedRingIds: new Set(),
    dismissedRingIds: new Set(),
    ...input,
  });
}

describe('selectCallToast — ringing', () => {
  it('shows the live ring with the fields the card needs', () => {
    expect(select({ incoming: ring() })).toEqual({
      mode: 'ringing',
      ringId: 'ring-1',
      meetingId: 'meeting-1',
      engagementId: 'eng-1',
      lens: 'client',
      callerLabel: 'Sandy',
      caseTitle: 'Flow migration',
      rateLine: 'From A$2.00/min · 15-minute minimum',
      awaitsAnswer: true,
      joinPath: '/meetings/meeting-1/call',
      expiresAtIso: FUTURE,
    });
  });

  it('is gone once the ring has expired', () => {
    expect(select({ incoming: ring({ expiresAtIso: PAST }) })).toBeNull();
  });

  it('is gone at the exact expiry instant', () => {
    expect(select({ incoming: ring({ expiresAtIso: '2026-11-19T10:00:00.000Z' }) })).toBeNull();
  });

  it('is gone for a declined ring', () => {
    expect(select({ incoming: ring(), declinedRingIds: new Set(['ring-1']) })).toBeNull();
  });

  it('beats unread missed rows and a pending-missed ring', () => {
    const rows = [
      missed('m1', '2026-11-19T09:00:00.000Z', { callerUserId: 'u1', callerLabel: 'Kim' }),
    ];
    const view = select({
      incoming: ring(),
      pendingMissed: ring({ ringId: 'ring-0' }),
      rows,
    });
    expect(view?.mode).toBe('ringing');
  });

  it('falls through to the missed rows when the ring is declined', () => {
    const rows = [
      missed('m1', '2026-11-19T09:00:00.000Z', { callerUserId: 'u1', callerLabel: 'Kim' }),
    ];
    const view = select({
      incoming: ring(),
      rows,
      declinedRingIds: new Set(['ring-1']),
    });
    expect(view).toMatchObject({ mode: 'missed', rowIds: ['m1'] });
  });
});

describe('selectCallToast — missed rows', () => {
  it('shows one unread call.no_answer row with its label, time, case and ring', () => {
    const rows = [
      missed('m1', '2026-11-19T09:00:00.000Z', {
        ringId: 'ring-9',
        callerUserId: 'u1',
        callerLabel: 'Sandy',
        startedAt: '2026-11-19T08:59:40.000Z',
      }),
    ];
    expect(select({ rows })).toEqual({
      mode: 'missed',
      key: 'rows:m1',
      rowIds: ['m1'],
      count: 1,
      callerLabel: 'Sandy',
      startedAt: '2026-11-19T08:59:40.000Z',
      engagementId: 'eng-1',
      fallbackTitle: null,
      fallbackBody: null,
      ringId: 'ring-9',
      pending: false,
    });
  });

  it('groups unread rows from the same caller into one count, newest first', () => {
    const rows = [
      missed('old', '2026-11-19T08:00:00.000Z', { callerUserId: 'u1', callerLabel: 'Sandy' }),
      missed('new', '2026-11-19T09:00:00.000Z', { callerUserId: 'u1', callerLabel: 'Sandy' }),
      missed('mid', '2026-11-19T08:30:00.000Z', { callerUserId: 'u1', callerLabel: 'Sandy' }),
    ];
    expect(select({ rows })).toMatchObject({ count: 3, rowIds: ['new', 'mid', 'old'] });
  });

  it('shows only the newest caller when callers differ, leaving the older caller unread', () => {
    const rows = [
      missed('kim', '2026-11-19T08:00:00.000Z', { callerUserId: 'u2', callerLabel: 'Kim' }),
      missed('sandy-new', '2026-11-19T09:00:00.000Z', { callerUserId: 'u1', callerLabel: 'Sandy' }),
      missed('sandy-old', '2026-11-19T08:30:00.000Z', { callerUserId: 'u1', callerLabel: 'Sandy' }),
    ];
    expect(select({ rows })).toMatchObject({
      callerLabel: 'Sandy',
      count: 2,
      rowIds: ['sandy-new', 'sandy-old'],
    });
  });

  it('never groups rows that lack a callerUserId, and falls back to the row title and body', () => {
    const rows = [
      missed('a', '2026-11-19T08:00:00.000Z', null),
      missed('b', '2026-11-19T09:00:00.000Z', null),
    ];
    expect(select({ rows })).toMatchObject({
      rowIds: ['b'],
      count: 1,
      callerLabel: null,
      fallbackTitle: 'Missed call b',
      fallbackBody: 'legacy body',
      startedAt: '2026-11-19T09:00:00.000Z',
    });
  });

  it('never groups rows whose metadata exists but names no caller', () => {
    const rows = [
      missed('a', '2026-11-19T08:00:00.000Z', { callerUserId: null, callerLabel: 'Sandy' }),
      missed('b', '2026-11-19T09:00:00.000Z', { callerUserId: null, callerLabel: 'Sandy' }),
    ];
    expect(select({ rows })).toMatchObject({ rowIds: ['b'], count: 1 });
  });

  it('does not group a legacy row with a new row from a known caller', () => {
    const rows = [
      missed('legacy', '2026-11-19T09:00:00.000Z', { callerUserId: null, callerLabel: null }),
      missed('known', '2026-11-19T08:00:00.000Z', { callerUserId: 'u1', callerLabel: 'Sandy' }),
    ];
    expect(select({ rows })).toMatchObject({ rowIds: ['legacy'] });
  });

  it('ignores read rows and rows of other events', () => {
    const rows = [
      missed(
        'read',
        '2026-11-19T09:00:00.000Z',
        { callerUserId: 'u1' },
        { readAt: '2026-11-19T09:05:00.000Z' }
      ),
      missed(
        'other',
        '2026-11-19T09:00:00.000Z',
        { callerUserId: 'u1' },
        { event: 'call.ringing' }
      ),
    ];
    expect(select({ rows })).toBeNull();
  });

  it('breaks a createdAt tie deterministically by id', () => {
    const rows = [
      missed('a', '2026-11-19T09:00:00.000Z', null),
      missed('b', '2026-11-19T09:00:00.000Z', null),
    ];
    expect(select({ rows })).toMatchObject({ rowIds: ['b'] });
    expect(select({ rows: [...rows].reverse() })).toMatchObject({ rowIds: ['b'] });
  });

  it('skips the rows of a declined or dismissed ring', () => {
    const rows = [
      missed('declined', '2026-11-19T09:00:00.000Z', { ringId: 'r-d', callerUserId: 'u1' }),
      missed('dismissed', '2026-11-19T08:00:00.000Z', { ringId: 'r-x', callerUserId: 'u2' }),
      missed('kept', '2026-11-19T07:00:00.000Z', {
        ringId: 'r-k',
        callerUserId: 'u3',
        callerLabel: 'Lee',
      }),
    ];
    expect(
      select({
        rows,
        declinedRingIds: new Set(['r-d']),
        dismissedRingIds: new Set(['r-x']),
      })
    ).toMatchObject({ rowIds: ['kept'] });
  });

  it('parses the engagement id from the action url and tolerates anything else', () => {
    expect(engagementIdFromActionUrl('/cases/eng-7?x=1')).toBe('eng-7');
    expect(engagementIdFromActionUrl('/cases/eng-7')).toBe('eng-7');
    expect(engagementIdFromActionUrl('/meetings/m/call')).toBeNull();
    expect(engagementIdFromActionUrl(null)).toBeNull();
  });

  it('exposes the grouping on its own', () => {
    const rows = [
      missed('a', '2026-11-19T09:00:00.000Z', { callerUserId: 'u1' }),
      missed('b', '2026-11-19T08:00:00.000Z', { callerUserId: 'u1' }),
    ];
    expect(groupMissedRows(rows).map((row) => row.id)).toEqual(['a', 'b']);
    expect(groupMissedRows([])).toEqual([]);
  });
});

describe('selectCallToast — pending-missed', () => {
  it('builds the missed toast from the cached ring until its row arrives', () => {
    expect(select({ pendingMissed: ring({ expiresAtIso: PAST }) })).toEqual({
      mode: 'missed',
      key: 'pending:ring-1',
      rowIds: [],
      count: 1,
      callerLabel: 'Sandy',
      startedAt: '2026-11-19T09:59:30.000Z',
      engagementId: 'eng-1',
      fallbackTitle: null,
      fallbackBody: null,
      ringId: 'ring-1',
      pending: true,
    });
  });

  it('is replaced by an unread row (rows take precedence)', () => {
    const rows = [
      missed('m1', '2026-11-19T09:59:59.000Z', {
        ringId: 'ring-1',
        callerUserId: 'u1',
        callerLabel: 'Sandy',
      }),
    ];
    expect(select({ pendingMissed: ring(), rows })).toMatchObject({
      pending: false,
      rowIds: ['m1'],
    });
  });

  it('clears once any no_answer row for that ring exists, even a read one', () => {
    const rows = [
      missed(
        'm1',
        '2026-11-19T09:59:59.000Z',
        { ringId: 'ring-1' },
        { readAt: '2026-11-19T10:00:00.000Z' }
      ),
    ];
    expect(select({ pendingMissed: ring(), rows })).toBeNull();
  });

  it('never appears for a declined ring', () => {
    expect(select({ pendingMissed: ring(), declinedRingIds: new Set(['ring-1']) })).toBeNull();
  });

  it('never appears for a dismissed ring', () => {
    expect(select({ pendingMissed: ring(), dismissedRingIds: new Set(['ring-1']) })).toBeNull();
  });

  it('is absent when there is nothing at all', () => {
    expect(select()).toBeNull();
  });
});
