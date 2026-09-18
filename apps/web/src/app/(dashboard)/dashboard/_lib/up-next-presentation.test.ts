import { describe, it, expect } from 'vitest';
import {
  formatUpNextWhen,
  resolveUpNextRowTiming,
  resolveRescheduleNote,
} from './up-next-presentation';
import { UP_NEXT_HAPPENING_NOW, upNextStartsIn } from './up-next-copy';
import type { UpNextRowView } from './up-next-view-types';

const MIN = 60_000;
const NOW = new Date('2026-09-17T12:00:00.000Z'); // Thursday

function row(overrides: Partial<UpNextRowView> = {}): UpNextRowView {
  return {
    meetingId: 'm-1',
    contextType: 'case',
    title: 'Consultation',
    counterpartyName: 'Priya',
    counterpartyOrgLabel: null,
    scheduledStart: new Date(NOW.getTime() + 30 * MIN).toISOString(),
    scheduledEnd: new Date(NOW.getTime() + 60 * MIN).toISOString(),
    status: 'scheduled',
    href: '/cases/1',
    joinPath: '/meetings/m-1/call',
    rescheduleProposalExpiresAt: null,
    ...overrides,
  };
}

describe('formatUpNextWhen', () => {
  it('formats a meeting later today as "Today, {time}" + duration', () => {
    const result = formatUpNextWhen(
      row({
        scheduledStart: new Date('2026-09-17T14:30:00.000Z').toISOString(),
        scheduledEnd: new Date('2026-09-17T15:00:00.000Z').toISOString(),
      }),
      NOW,
      'UTC'
    );
    expect(result.primary).toBe('Today, 2:30 pm');
    expect(result.secondary).toBe('30 min');
  });

  it('formats a meeting tomorrow as "Tomorrow, {time}" + duration', () => {
    const result = formatUpNextWhen(
      row({
        scheduledStart: new Date('2026-09-18T09:00:00.000Z').toISOString(),
        scheduledEnd: new Date('2026-09-18T10:00:00.000Z').toISOString(),
      }),
      NOW,
      'UTC'
    );
    expect(result.primary).toBe('Tomorrow, 9:00 am');
    expect(result.secondary).toBe('60 min');
  });

  it('formats a later day as "{Weekday d Mon}" + "{time}, {duration} min"', () => {
    const result = formatUpNextWhen(
      row({
        scheduledStart: new Date('2026-09-19T15:00:00.000Z').toISOString(),
        scheduledEnd: new Date('2026-09-19T15:45:00.000Z').toISOString(),
      }),
      NOW,
      'UTC'
    );
    expect(result.primary).toBe('Sat 19 Sep');
    expect(result.secondary).toBe('3:00 pm, 45 min');
  });

  it('lowercases am/pm', () => {
    const result = formatUpNextWhen(
      row({
        scheduledStart: new Date('2026-09-17T00:00:00.000Z').toISOString(),
        scheduledEnd: new Date('2026-09-17T00:30:00.000Z').toISOString(),
      }),
      NOW,
      'UTC'
    );
    expect(result.primary).toContain('am');
    expect(result.primary).not.toContain('AM');
  });

  it('Melbourne vs Los Angeles give different day keys for one instant (DST/zone correctness)', () => {
    const startIso = new Date('2026-09-17T23:00:00.000Z').toISOString(); // late UTC evening
    const melbourne = formatUpNextWhen(
      row({ scheduledStart: startIso, scheduledEnd: startIso }),
      NOW,
      'Australia/Melbourne'
    );
    const losAngeles = formatUpNextWhen(
      row({ scheduledStart: startIso, scheduledEnd: startIso }),
      NOW,
      'America/Los_Angeles'
    );
    // Melbourne is already past midnight (next day, not "Today"); LA is still "Today".
    expect(melbourne.primary).not.toContain('Today');
    expect(losAngeles.primary).toContain('Today');
  });
});

describe('resolveUpNextRowTiming', () => {
  it('−15 min exactly (inclusive) → joinVisible true, starting_soon', () => {
    const start = new Date(NOW.getTime() + 15 * MIN);
    const timing = resolveUpNextRowTiming(
      row({
        scheduledStart: start.toISOString(),
        scheduledEnd: new Date(start.getTime() + 30 * MIN).toISOString(),
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(true);
    expect(timing.rowState).toBe('starting_soon');
    expect(timing.statusLine).toBe(upNextStartsIn(15));
  });

  it('−16 min → joinVisible false (before the window opens)', () => {
    const start = new Date(NOW.getTime() + 16 * MIN);
    const timing = resolveUpNextRowTiming(
      row({
        scheduledStart: start.toISOString(),
        scheduledEnd: new Date(start.getTime() + 30 * MIN).toISOString(),
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(false);
    expect(timing.rowState).toBe('upcoming');
    expect(timing.statusLine).toBeNull();
  });

  it('end + 29 min → still joinVisible (inside the overrun grace)', () => {
    const end = new Date(NOW.getTime() - 29 * MIN);
    const start = new Date(end.getTime() - 30 * MIN);
    const timing = resolveUpNextRowTiming(
      row({
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        status: 'in_progress',
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(true);
    expect(timing.visible).toBe(true);
  });

  it('end + 30 min → not visible (grace elapsed)', () => {
    const end = new Date(NOW.getTime() - 30 * MIN);
    const start = new Date(end.getTime() - 30 * MIN);
    const timing = resolveUpNextRowTiming(
      row({
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        status: 'in_progress',
      }),
      NOW
    );
    expect(timing.joinVisible).toBe(false);
    expect(timing.visible).toBe(false);
  });

  it('ended → never visible, regardless of time', () => {
    const timing = resolveUpNextRowTiming(row({ status: 'ended' }), NOW);
    expect(timing.visible).toBe(false);
    expect(timing.joinVisible).toBe(false);
  });

  it('in_progress before the scheduled start (early start) → happening_now', () => {
    const start = new Date(NOW.getTime() + 5 * MIN);
    const timing = resolveUpNextRowTiming(
      row({
        scheduledStart: start.toISOString(),
        scheduledEnd: new Date(start.getTime() + 30 * MIN).toISOString(),
        status: 'in_progress',
      }),
      NOW
    );
    expect(timing.rowState).toBe('happening_now');
    expect(timing.statusLine).toBe(UP_NEXT_HAPPENING_NOW);
  });

  it('−0 signed minutes (right at start) → happening_now, not starting_soon', () => {
    const timing = resolveUpNextRowTiming(
      row({
        scheduledStart: NOW.toISOString(),
        scheduledEnd: new Date(NOW.getTime() + 30 * MIN).toISOString(),
        status: 'scheduled',
      }),
      NOW
    );
    expect(timing.rowState).toBe('happening_now');
    expect(timing.statusLine).toBe(UP_NEXT_HAPPENING_NOW);
  });
});

describe('resolveRescheduleNote (D4)', () => {
  it('company workspace: "New times suggested" for a live pending case proposal', () => {
    const note = resolveRescheduleNote(
      row({
        contextType: 'case',
        status: 'scheduled',
        rescheduleProposalExpiresAt: new Date(NOW.getTime() + 60 * MIN).toISOString(),
      }),
      NOW,
      'company'
    );
    expect(note).toBe('New times suggested');
  });

  it('expert workspace: "Waiting on their reply" for the same live proposal', () => {
    const note = resolveRescheduleNote(
      row({
        contextType: 'case',
        status: 'scheduled',
        rescheduleProposalExpiresAt: new Date(NOW.getTime() + 60 * MIN).toISOString(),
      }),
      NOW,
      'expert'
    );
    expect(note).toBe('Waiting on their reply');
  });

  it('an expired proposal (at the tick) yields null', () => {
    const note = resolveRescheduleNote(
      row({
        contextType: 'case',
        status: 'scheduled',
        rescheduleProposalExpiresAt: new Date(NOW.getTime() - 1 * MIN).toISOString(),
      }),
      NOW,
      'company'
    );
    expect(note).toBeNull();
  });

  it('a kickoff row with an expiry set still yields null (case-only)', () => {
    const note = resolveRescheduleNote(
      row({
        contextType: 'project_kickoff',
        status: 'scheduled',
        rescheduleProposalExpiresAt: new Date(NOW.getTime() + 60 * MIN).toISOString(),
      }),
      NOW,
      'company'
    );
    expect(note).toBeNull();
  });

  it('in_progress yields null even with a live proposal', () => {
    const note = resolveRescheduleNote(
      row({
        contextType: 'case',
        status: 'in_progress',
        rescheduleProposalExpiresAt: new Date(NOW.getTime() + 60 * MIN).toISOString(),
      }),
      NOW,
      'company'
    );
    expect(note).toBeNull();
  });

  it('no expiry at all yields null', () => {
    const note = resolveRescheduleNote(
      row({ contextType: 'case', rescheduleProposalExpiresAt: null }),
      NOW,
      'company'
    );
    expect(note).toBeNull();
  });
});
