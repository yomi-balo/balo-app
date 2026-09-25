import { describe, it, expect } from 'vitest';
import {
  selectUpNextRows,
  upNextWindow,
  isUpNextMeetingType,
  UP_NEXT_ROW_LIMIT,
  UP_NEXT_LOOKBACK_MS,
  UP_NEXT_HORIZON_DAYS,
  type UpNextCandidate,
} from './select-up-next-rows';
import { meetingIsClosedToJoin, type MeetingLifecycleStatus } from '@balo/shared/meetings';
import { caseConsultationIsUpcoming, deriveCaseConsultationState } from '@balo/shared/engagements';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const MIN = 60_000;

function candidate(overrides: Partial<UpNextCandidate> = {}): UpNextCandidate {
  return {
    meetingId: 'm-1',
    scheduledStart: new Date(NOW.getTime() + 30 * MIN),
    scheduledEnd: new Date(NOW.getTime() + 60 * MIN),
    status: 'scheduled',
    contextType: 'case',
    contextId: 'ctx-1',
    projectRequestId: null,
    owningRowFound: true,
    roomReady: true,
    ...overrides,
  };
}

describe('upNextWindow', () => {
  it('is now − 2h .. now + 14d', () => {
    const { rangeStart, rangeEnd } = upNextWindow(NOW);
    expect(rangeStart.getTime()).toBe(NOW.getTime() - UP_NEXT_LOOKBACK_MS);
    expect(rangeEnd.getTime()).toBe(NOW.getTime() + UP_NEXT_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe('isUpNextMeetingType', () => {
  it('accepts the four listed types', () => {
    expect(isUpNextMeetingType('case')).toBe(true);
    expect(isUpNextMeetingType('project_kickoff')).toBe(true);
    expect(isUpNextMeetingType('project_discovery')).toBe(true);
    expect(isUpNextMeetingType('request_interaction')).toBe(true);
  });

  it('rejects package/retainer sessions', () => {
    expect(isUpNextMeetingType('package_session')).toBe(false);
    expect(isUpNextMeetingType('retainer_checkin')).toBe(false);
  });
});

describe('selectUpNextRows', () => {
  it('drops package_session and retainer_checkin rows', () => {
    const rows = [
      candidate({ meetingId: 'a', contextType: 'package_session' }),
      candidate({ meetingId: 'b', contextType: 'retainer_checkin' }),
      candidate({ meetingId: 'c', contextType: 'case' }),
    ];
    const selected = selectUpNextRows(rows, NOW);
    expect(selected.map((r) => r.meetingId)).toEqual(['c']);
  });

  it('caps at the limit, preserving input order (no sort)', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      candidate({ meetingId: `m-${i}`, scheduledStart: new Date(NOW.getTime() + (i + 1) * MIN) })
    );
    const selected = selectUpNextRows(rows, NOW);
    expect(selected).toHaveLength(UP_NEXT_ROW_LIMIT);
    expect(selected.map((r) => r.meetingId)).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
  });

  it('a custom limit narrows the cap', () => {
    const rows = [candidate({ meetingId: 'a' }), candidate({ meetingId: 'b' })];
    expect(selectUpNextRows(rows, NOW, 1).map((r) => r.meetingId)).toEqual(['a']);
  });

  it('keeps an in-progress meeting', () => {
    const row = candidate({
      status: 'in_progress',
      scheduledStart: new Date(NOW.getTime() - 10 * MIN),
      scheduledEnd: new Date(NOW.getTime() + 20 * MIN),
    });
    expect(selectUpNextRows([row], NOW)).toHaveLength(1);
  });

  it('keeps waiting_for_participants', () => {
    const row = candidate({ status: 'waiting_for_participants' });
    expect(selectUpNextRows([row], NOW)).toHaveLength(1);
  });

  it('drops ended and cancelled meetings', () => {
    const ended = candidate({ meetingId: 'ended', status: 'ended' });
    const cancelled = candidate({ meetingId: 'cancelled', status: 'cancelled' });
    expect(selectUpNextRows([ended, cancelled], NOW)).toEqual([]);
  });

  it('drops a meeting whose join window has closed even though status is still scheduled (past-grace)', () => {
    const stale = candidate({
      status: 'scheduled',
      scheduledStart: new Date(NOW.getTime() - 5 * 60 * MIN),
      scheduledEnd: new Date(NOW.getTime() - 90 * MIN), // well past the 30-min overrun grace
    });
    expect(selectUpNextRows([stale], NOW)).toEqual([]);
  });

  it('returns [] for an empty input with zero iteration cost', () => {
    expect(selectUpNextRows([], NOW)).toEqual([]);
  });

  /**
   * D2's single-definition proof: the case-surface "is this consultation upcoming" rule and the
   * calendar join-window "is this meeting past" rule must never disagree, for every status.
   */
  it('D2 — caseConsultationIsUpcoming and !meetingIsClosedToJoin agree for every status', () => {
    const ALL_STATUSES: readonly MeetingLifecycleStatus[] = [
      'scheduled',
      'waiting_for_participants',
      'in_progress',
      'ended',
      'cancelled',
    ];
    for (const status of ALL_STATUSES) {
      const upcoming = caseConsultationIsUpcoming(
        deriveCaseConsultationState({
          status,
          outcome: null,
          hasLiveRescheduleProposal: false,
          clientSideEverPresent: null,
        })
      );
      expect(!meetingIsClosedToJoin(status)).toBe(upcoming);
    }
    // non-vacuity: at least one true and one false in the set.
    const results = ALL_STATUSES.map((status) => !meetingIsClosedToJoin(status));
    expect(results).toContain(true);
    expect(results).toContain(false);
  });
});
