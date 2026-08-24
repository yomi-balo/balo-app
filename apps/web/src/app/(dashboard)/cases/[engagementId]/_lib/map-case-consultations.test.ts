import { describe, it, expect, vi } from 'vitest';
import type { Meeting } from '@balo/db';
import { mapCaseConsultations, type CaseConsultationCounts } from './map-case-consultations';
import { log } from '@/lib/logging';

/**
 * BAL-421 — unit tests for THE PROJECTION BOUNDARY.
 *
 * ⚠⚠ EVERY FIXTURE CARRIES A REAL-LOOKING `joinUrl` AND `dailyRoomName`, AND THAT IS THE
 * POINT. `listMeetingsForContext` returns FULL `Meeting` rows including live call-join
 * credentials, and TypeScript's excess-property checking does NOT apply to spreads — so the
 * day someone "simplifies" the field-by-field build into `{ ...meeting, state }`, every type
 * stays green and the browser starts receiving room locators. The leak assertions below
 * serialize the WHOLE output and look for the secret, so they cannot be satisfied by a type.
 *
 * ⚠ `@balo/shared/engagements` and `derive-consultation-ordinal` ARE REAL — the state
 * derivation and the ordinal rule are what these tests are actually pinning. `@balo/db` is
 * imported for TYPES ONLY here (as it is in the module under test), so it is erased and needs
 * no mock.
 */

vi.mock('server-only', () => ({}));

const JOIN_URL = 'https://balo.daily.co/case-room-7f3a?t=SUPERSECRETJOINTOKEN';
const ROOM_NAME = 'case-room-7f3a';

const EMPTY_COUNTS: CaseConsultationCounts = {
  actionItemCountByMeetingId: new Map(),
  fileCountByMeetingId: new Map(),
  meetingIdsWithTranscript: new Set(),
  meetingIdsWithLiveProposal: new Set(),
};

/**
 * A FULL `Meeting` row — credentials included, exactly as the repository hands one over.
 * Cast at the boundary because the real row has many more columns than any assertion needs;
 * the leak tests below are what actually police the extra ones.
 */
function meeting(over: Partial<Meeting> & { id: string }): Meeting {
  return {
    scheduledStart: new Date('2026-07-01T10:00:00Z'),
    scheduledEnd: new Date('2026-07-01T10:30:00Z'),
    startedAt: null,
    endedAt: null,
    status: 'scheduled',
    outcome: null,
    joinUrl: JOIN_URL,
    dailyRoomName: ROOM_NAME,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  } as unknown as Meeting;
}

/** An `ended` + `completed` meeting with real stamps — the ordinary "held" shape. */
function held(id: string, over: Partial<Meeting> = {}): Meeting {
  return meeting({
    id,
    status: 'ended',
    outcome: 'completed',
    startedAt: new Date('2026-07-01T10:00:00Z'),
    endedAt: new Date('2026-07-01T10:42:00Z'),
    ...over,
  });
}

describe('mapCaseConsultations — the SECRET-LEAK boundary', () => {
  it('emits NO joinUrl and NO dailyRoomName on ANY row, in any state', async () => {
    const rows = mapCaseConsultations(
      [
        held('m1'),
        meeting({ id: 'm2' }),
        meeting({ id: 'm3', status: 'in_progress', startedAt: new Date('2026-07-02T10:00:00Z') }),
        meeting({ id: 'm4', status: 'cancelled' }),
      ],
      EMPTY_COUNTS
    );

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(JOIN_URL);
    expect(serialized).not.toContain(ROOM_NAME);
    expect(serialized).not.toContain('SUPERSECRETJOINTOKEN');
    for (const row of rows) {
      expect(row).not.toHaveProperty('joinUrl');
      expect(row).not.toHaveProperty('dailyRoomName');
    }
  });

  /**
   * The allow-list, spelled out. A new `meetings` column that silently joined the client
   * payload would fail HERE — which is the whole reason the mapper builds field by field.
   */
  it('emits EXACTLY the declared field set — nothing joins the payload by accident', () => {
    const [row] = mapCaseConsultations([held('m1')], EMPTY_COUNTS);
    expect(row === undefined ? [] : Object.keys(row).sort()).toEqual([
      'actionItemCount',
      'durationMinutes',
      'fileCount',
      'hasRecording',
      'hasTranscript',
      'meetingId',
      'ordinal',
      'recapHref',
      'scheduledStartIso',
      'startedAtIso',
      'state',
    ]);
  });

  it('consumes `status` and `outcome` and NEVER serializes them — the client gets the LABEL', () => {
    const [row] = mapCaseConsultations([held('m1')], EMPTY_COUNTS);
    expect(row?.state).toBe('held');
    expect(row).not.toHaveProperty('status');
    expect(row).not.toHaveProperty('outcome');
  });
});

describe('mapCaseConsultations — state derivation', () => {
  it.each([
    ['scheduled', { status: 'scheduled', outcome: null }, 'scheduled'],
    [
      'waiting_for_participants',
      { status: 'waiting_for_participants', outcome: null },
      'scheduled',
    ],
    ['in_progress', { status: 'in_progress', outcome: null }, 'in_progress'],
    ['ended+completed', { status: 'ended', outcome: 'completed' }, 'held'],
    ['ended+no_show_client', { status: 'ended', outcome: 'no_show_client' }, 'no_show_client'],
    ['ended+missed_call', { status: 'ended', outcome: 'missed_call' }, 'missed_call'],
    ['cancelled', { status: 'cancelled', outcome: null }, 'cancelled'],
    ['ended+NULL outcome', { status: 'ended', outcome: null }, 'outcome_pending'],
  ])('maps %s → %s', (_label, row, expected) => {
    const [mapped] = mapCaseConsultations(
      [meeting({ id: 'm1', ...(row as Partial<Meeting>) })],
      EMPTY_COUNTS
    );
    expect(mapped?.state).toBe(expected);
  });

  /**
   * ⚠ THE TWO NON-HELD OUTCOMES ARE NOT INTERCHANGEABLE. `no_show_client` is "the client did
   * not turn up"; `missed_call` is "the call did not happen". They carry different copy and,
   * on the billing side, different money consequences — collapsing them into one "didn't
   * happen" label would tell one party the other stood them up when nobody did.
   */
  it('keeps no_show_client and missed_call DISTINCT', () => {
    const rows = mapCaseConsultations(
      [
        meeting({
          id: 'm1',
          status: 'ended',
          outcome: 'no_show_client',
          startedAt: new Date('2026-07-01T10:00:00Z'),
        }),
        meeting({
          id: 'm2',
          status: 'ended',
          outcome: 'missed_call',
          startedAt: new Date('2026-07-02T10:00:00Z'),
        }),
      ],
      EMPTY_COUNTS
    );
    expect(rows.map((r) => r.state)).toEqual(['no_show_client', 'missed_call']);
    expect(rows[0]?.state).not.toBe(rows[1]?.state);
  });

  it('warns when a meeting ENDED with no outcome recorded — it must not be invisible', () => {
    vi.mocked(log.warn).mockClear();
    mapCaseConsultations([meeting({ id: 'm1', status: 'ended', outcome: null })], EMPTY_COUNTS);
    expect(log.warn).toHaveBeenCalledWith(
      'Case consultation ended with no outcome recorded',
      expect.objectContaining({ meetingId: 'm1', status: 'ended' })
    );
  });
});

/**
 * ⚠ ONLY A TERMINAL MEETING HAS A RECAP. `loadRecap` returns `null` — and the recap page 404s
 * — for the three non-terminal statuses, so linking one would send the viewer from their own
 * case to a dead end. `cancelled` DOES render a recap (the not-held panel), so it keeps its
 * link. NEVER a disabled link.
 */
describe('mapCaseConsultations — recapHref', () => {
  it.each([
    ['held', { status: 'ended', outcome: 'completed' }],
    ['no_show_client', { status: 'ended', outcome: 'no_show_client' }],
    ['missed_call', { status: 'ended', outcome: 'missed_call' }],
    ['outcome_pending', { status: 'ended', outcome: null }],
    ['cancelled', { status: 'cancelled', outcome: null }],
  ])('EMITS a recap link for %s', (_label, row) => {
    const [mapped] = mapCaseConsultations(
      [meeting({ id: 'm1', ...(row as Partial<Meeting>) })],
      EMPTY_COUNTS
    );
    expect(mapped?.recapHref).toBe('/meetings/m1?from=case_surface');
  });

  it.each([
    ['scheduled', { status: 'scheduled', outcome: null }],
    ['waiting_for_participants', { status: 'waiting_for_participants', outcome: null }],
    ['in_progress', { status: 'in_progress', outcome: null }],
  ])('emits NO recap link for %s — an absent action beats a dead one', (_label, row) => {
    const [mapped] = mapCaseConsultations(
      [meeting({ id: 'm1', ...(row as Partial<Meeting>) })],
      EMPTY_COUNTS
    );
    expect(mapped?.recapHref).toBeNull();
  });

  it('carries the `from=case_surface` provenance param', () => {
    const [mapped] = mapCaseConsultations([held('m1')], EMPTY_COUNTS);
    expect(mapped?.recapHref).toContain('?from=case_surface');
  });
});

describe('mapCaseConsultations — duration, counts and ordering', () => {
  it('computes WALL-CLOCK minutes between the two stamps', () => {
    const [mapped] = mapCaseConsultations([held('m1')], EMPTY_COUNTS);
    expect(mapped?.durationMinutes).toBe(42);
  });

  it('reports NULL duration — never a bare zero — when a stamp is missing', () => {
    const [scheduled] = mapCaseConsultations([meeting({ id: 'm1' })], EMPTY_COUNTS);
    expect(scheduled?.durationMinutes).toBeNull();

    const [started] = mapCaseConsultations(
      [meeting({ id: 'm2', status: 'in_progress', startedAt: new Date('2026-07-01T10:00:00Z') })],
      EMPTY_COUNTS
    );
    expect(started?.durationMinutes).toBeNull();
  });

  it('reads the three counts from the batched maps, defaulting to 0 / false', () => {
    const rows = mapCaseConsultations([held('m1'), held('m2')], {
      actionItemCountByMeetingId: new Map([['m1', 3]]),
      fileCountByMeetingId: new Map([['m1', 2]]),
      meetingIdsWithTranscript: new Set(['m1']),
      meetingIdsWithLiveProposal: new Set(),
    });
    const [first, second] = rows;
    expect(first).toMatchObject({ actionItemCount: 3, fileCount: 2, hasTranscript: true });
    expect(second).toMatchObject({ actionItemCount: 0, fileCount: 0, hasTranscript: false });
  });

  /**
   * BAL-411 — `pending_reschedule` is nested INSIDE the `scheduled` branch of
   * `deriveCaseConsultationState`, so a meeting carrying a LIVE proposal renders that state
   * instead of plain `scheduled`. This is the projection boundary's own wiring test; the
   * derivation's full priority table lives in `@balo/shared/engagements`'s own suite.
   */
  it('BAL-411 — a meeting in meetingIdsWithLiveProposal renders pending_reschedule, not scheduled', () => {
    const [withProposal, withoutProposal] = mapCaseConsultations(
      [meeting({ id: 'm1' }), meeting({ id: 'm2' })],
      { ...EMPTY_COUNTS, meetingIdsWithLiveProposal: new Set(['m1']) }
    );
    expect(withProposal?.state).toBe('pending_reschedule');
    expect(withoutProposal?.state).toBe('scheduled');
  });

  it('hard-falses hasRecording — no capture exists anywhere on the platform', () => {
    const rows = mapCaseConsultations([held('m1'), meeting({ id: 'm2' })], EMPTY_COUNTS);
    expect(rows.every((row) => row.hasRecording === false)).toBe(true);
  });

  it('sorts NEWEST LAST, by occurrence time, so the case reads as a story', () => {
    const rows = mapCaseConsultations(
      [
        held('m-late', {
          startedAt: new Date('2026-07-09T10:00:00Z'),
          endedAt: new Date('2026-07-09T10:30:00Z'),
        }),
        held('m-early', {
          startedAt: new Date('2026-07-01T10:00:00Z'),
          endedAt: new Date('2026-07-01T10:30:00Z'),
        }),
        held('m-mid', {
          startedAt: new Date('2026-07-05T10:00:00Z'),
          endedAt: new Date('2026-07-05T10:30:00Z'),
        }),
      ],
      EMPTY_COUNTS
    );
    expect(rows.map((row) => row.meetingId)).toEqual(['m-early', 'm-mid', 'm-late']);
  });

  it('falls back to scheduledStart for a row that never started, and breaks ties by id', () => {
    const at = new Date('2026-07-03T09:00:00Z');
    const rows = mapCaseConsultations(
      [meeting({ id: 'm-b', scheduledStart: at }), meeting({ id: 'm-a', scheduledStart: at })],
      EMPTY_COUNTS
    );
    expect(rows.map((row) => row.meetingId)).toEqual(['m-a', 'm-b']);
  });

  it('numbers HELD consultations 1..n and gives a CANCELLED row NO ordinal', () => {
    const rows = mapCaseConsultations(
      [
        held('m1', {
          startedAt: new Date('2026-07-01T10:00:00Z'),
          endedAt: new Date('2026-07-01T10:30:00Z'),
        }),
        meeting({
          id: 'm2',
          status: 'cancelled',
          scheduledStart: new Date('2026-07-02T10:00:00Z'),
        }),
        held('m3', {
          startedAt: new Date('2026-07-03T10:00:00Z'),
          endedAt: new Date('2026-07-03T10:30:00Z'),
        }),
      ],
      EMPTY_COUNTS
    );
    const byId = new Map(rows.map((row) => [row.meetingId, row.ordinal]));
    expect(byId.get('m1')).toBe(1);
    expect(byId.get('m2')).toBeNull();
    expect(byId.get('m3')).toBe(2);
  });

  it('returns an empty list for an empty input, without throwing', () => {
    expect(mapCaseConsultations([], EMPTY_COUNTS)).toEqual([]);
  });
});
