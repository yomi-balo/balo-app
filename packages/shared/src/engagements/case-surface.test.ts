import { describe, expect, it } from 'vitest';
import {
  CASE_JOIN_WINDOW_MINUTES,
  caseConsultationIsUpcoming,
  deriveCaseConsultationState,
  selectCaseNudge,
  type CaseConsultationStateLabel,
  type CaseNudgeInput,
  type MeetingOutcomeLabel,
  type MeetingStatusLabel,
} from './case-surface';

const NOW = new Date('2026-08-12T10:00:00.000Z');
const MS_PER_MINUTE = 60_000;

function at(minutesFromNow: number): Date {
  return new Date(NOW.getTime() + minutesFromNow * MS_PER_MINUTE);
}

function nudgeInput(overrides: Partial<CaseNudgeInput> = {}): CaseNudgeInput {
  return {
    lens: 'client',
    isOpen: true,
    nextScheduled: null,
    resolutionRequestedAt: null,
    now: NOW,
    ...overrides,
  };
}

describe('selectCaseNudge', () => {
  describe('exactly one nudge, by priority', () => {
    /**
     * The whole contract in one table: for every combination the header can be in, EXACTLY
     * one nudge kind comes back. This is what stops two prompts stacking.
     */
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly input: Partial<CaseNudgeInput>;
      readonly expected: string | null;
    }> = [
      // ── arm 1: a closed case has no nudge at all, whatever else is true ────────────
      { name: 'closed, nothing else', input: { isOpen: false }, expected: null },
      {
        name: 'closed WITH an upcoming consultation',
        input: { isOpen: false, nextScheduled: { meetingId: 'm1', scheduledStart: at(60) } },
        expected: null,
      },
      {
        name: 'closed WITH a pending resolution ask',
        input: { isOpen: false, resolutionRequestedAt: NOW },
        expected: null,
      },
      {
        name: 'closed, expert lens, everything set',
        input: {
          lens: 'expert',
          isOpen: false,
          nextScheduled: { meetingId: 'm1', scheduledStart: at(60) },
          resolutionRequestedAt: NOW,
        },
        expected: null,
      },
      // ── arm 2: anything booked wins ───────────────────────────────────────────────
      {
        name: 'booked, client lens',
        input: { nextScheduled: { meetingId: 'm1', scheduledStart: at(60) } },
        expected: 'upcoming',
      },
      {
        name: 'booked, expert lens',
        input: { lens: 'expert', nextScheduled: { meetingId: 'm1', scheduledStart: at(60) } },
        expected: 'upcoming',
      },
      // ── arm 3: the ask, split by lens ─────────────────────────────────────────────
      {
        name: 'ask pending, client lens',
        input: { resolutionRequestedAt: NOW },
        expected: 'resolution_ask',
      },
      {
        name: 'ask pending, expert lens',
        input: { lens: 'expert', resolutionRequestedAt: NOW },
        expected: 'resolution_ask_pending',
      },
      // ── arm 4: the quiet default ──────────────────────────────────────────────────
      { name: 'nothing at all, client lens', input: {}, expected: 'nothing_booked' },
      {
        name: 'nothing at all, expert lens',
        input: { lens: 'expert' },
        expected: 'nothing_booked',
      },
    ];

    it.each(cases)('$name → $expected', ({ input, expected }) => {
      const nudge = selectCaseNudge(nudgeInput(input));
      expect(nudge === null ? null : nudge.kind).toBe(expected);
    });
  });

  /**
   * ⚠ THE SUPPRESSION RULE, PINNED. "Is this resolved?" must never be asked while a call is
   * already booked — it contradicts a commitment both parties made. It falls out of arm 2
   * sitting above arm 3, so this test is what stops someone "fixing" the ordering.
   */
  it('SUPPRESSES the resolution ask while a consultation is booked — BOTH lenses', () => {
    const booked = { meetingId: 'm1', scheduledStart: at(4320) };

    expect(
      selectCaseNudge(nudgeInput({ nextScheduled: booked, resolutionRequestedAt: NOW }))
    ).toMatchObject({ kind: 'upcoming' });

    expect(
      selectCaseNudge(
        nudgeInput({ lens: 'expert', nextScheduled: booked, resolutionRequestedAt: NOW })
      )
    ).toMatchObject({ kind: 'upcoming' });
  });

  describe('the live join window', () => {
    it.each([
      { name: 'well outside', minutes: CASE_JOIN_WINDOW_MINUTES + 60, live: false },
      { name: 'just outside', minutes: CASE_JOIN_WINDOW_MINUTES + 1, live: false },
      {
        name: 'exactly at the boundary (inclusive)',
        minutes: CASE_JOIN_WINDOW_MINUTES,
        live: true,
      },
      { name: 'just inside', minutes: CASE_JOIN_WINDOW_MINUTES - 1, live: true },
      { name: 'starting right now', minutes: 0, live: true },
      { name: 'already started (running late)', minutes: -5, live: true },
    ])('$name → live: $live', ({ minutes, live }) => {
      const nudge = selectCaseNudge(
        nudgeInput({ nextScheduled: { meetingId: 'm1', scheduledStart: at(minutes) } })
      );
      expect(nudge).toMatchObject({ kind: 'upcoming', live });
    });
  });

  it('carries the meetingId and start straight through, so the CTA has a real destination', () => {
    const scheduledStart = at(30);
    expect(
      selectCaseNudge(nudgeInput({ nextScheduled: { meetingId: 'meeting-9', scheduledStart } }))
    ).toEqual({ kind: 'upcoming', meetingId: 'meeting-9', scheduledStart, live: false });
  });
});

describe('deriveCaseConsultationState', () => {
  /**
   * TOTAL over every representable `(status, outcome)` pair. `meeting_outcome_requires_ended`
   * is one-directional, so `ended` + `null` IS legal and must have its own honest state.
   */
  const STATUSES: readonly MeetingStatusLabel[] = [
    'scheduled',
    'waiting_for_participants',
    'in_progress',
    'ended',
    'cancelled',
  ];
  const OUTCOMES: ReadonlyArray<MeetingOutcomeLabel | null> = [
    null,
    'completed',
    'no_show_client',
    'missed_call',
  ];

  it('is TOTAL — every (status, outcome) pair yields a label', () => {
    for (const status of STATUSES) {
      for (const outcome of OUTCOMES) {
        expect(typeof deriveCaseConsultationState({ status, outcome })).toBe('string');
      }
    }
  });

  it.each([
    { status: 'scheduled', outcome: null, expected: 'scheduled' },
    { status: 'waiting_for_participants', outcome: null, expected: 'scheduled' },
    { status: 'in_progress', outcome: null, expected: 'in_progress' },
    { status: 'ended', outcome: 'completed', expected: 'held' },
    { status: 'ended', outcome: 'no_show_client', expected: 'no_show_client' },
    { status: 'ended', outcome: 'missed_call', expected: 'missed_call' },
    { status: 'ended', outcome: null, expected: 'outcome_pending' },
    { status: 'cancelled', outcome: null, expected: 'cancelled' },
  ] as ReadonlyArray<{
    status: MeetingStatusLabel;
    outcome: MeetingOutcomeLabel | null;
    expected: CaseConsultationStateLabel;
  }>)('$status + $outcome → $expected', ({ status, outcome, expected }) => {
    expect(deriveCaseConsultationState({ status, outcome })).toBe(expected);
  });

  /**
   * ⚠ THE TWO NO-SHOW OUTCOMES ARE DIFFERENT EVENTS AND MUST STAY DIFFERENT LABELS —
   * `no_show_client` means the expert waited; `missed_call` means the expert never joined.
   * Folding them would hide WHO failed to show, which is the row's load-bearing fact.
   */
  it('keeps no_show_client and missed_call DISTINCT', () => {
    const noShow = deriveCaseConsultationState({ status: 'ended', outcome: 'no_show_client' });
    const missed = deriveCaseConsultationState({ status: 'ended', outcome: 'missed_call' });
    expect(noShow).not.toBe(missed);
  });

  /** A cancelled meeting is cancelled whatever else the row happens to carry. */
  it('lets cancelled win over any outcome', () => {
    for (const outcome of OUTCOMES) {
      expect(deriveCaseConsultationState({ status: 'cancelled', outcome })).toBe('cancelled');
    }
  });
});

describe('caseConsultationIsUpcoming', () => {
  it.each([
    { state: 'scheduled', upcoming: true },
    { state: 'in_progress', upcoming: true },
    { state: 'held', upcoming: false },
    { state: 'no_show_client', upcoming: false },
    { state: 'missed_call', upcoming: false },
    { state: 'cancelled', upcoming: false },
    { state: 'outcome_pending', upcoming: false },
  ] as ReadonlyArray<{ state: CaseConsultationStateLabel; upcoming: boolean }>)(
    '$state → $upcoming',
    ({ state, upcoming }) => {
      expect(caseConsultationIsUpcoming(state)).toBe(upcoming);
    }
  );
});
