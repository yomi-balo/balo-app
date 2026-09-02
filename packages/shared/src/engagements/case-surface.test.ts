import { describe, expect, it } from 'vitest';
import { IDLE_END_EMPTY_MS } from '../meetings/timers';
import {
  CASE_JOIN_WINDOW_MINUTES,
  MEETING_OVERRUN_GRACE_MINUTES,
  caseConsultationIsUpcoming,
  deriveCaseConsultationState,
  selectCaseNudge,
  type CaseConsultationStateLabel,
  type CaseNudgeInput,
  type CaseNudgeRescheduleProposal,
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
    rescheduleProposal: null,
    now: NOW,
    ...overrides,
  };
}

function liveProposal(
  overrides: Partial<CaseNudgeRescheduleProposal> = {}
): CaseNudgeRescheduleProposal {
  return {
    proposalId: 'proposal-1',
    meetingId: 'm1',
    optionCount: 2,
    originalScheduledStart: at(4320),
    expiresAt: at(60),
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
        name: 'closed WITH a live reschedule proposal',
        input: { isOpen: false, rescheduleProposal: liveProposal() },
        expected: null,
      },
      {
        name: 'closed, expert lens, everything set',
        input: {
          lens: 'expert',
          isOpen: false,
          nextScheduled: { meetingId: 'm1', scheduledStart: at(60) },
          resolutionRequestedAt: NOW,
          rescheduleProposal: liveProposal(),
        },
        expected: null,
      },
      // ── arm 2: a LIVE reschedule proposal wins over everything below it ────────────
      {
        name: 'live reschedule proposal, client lens',
        input: { rescheduleProposal: liveProposal() },
        expected: 'reschedule_proposal',
      },
      {
        name: 'live reschedule proposal, expert lens',
        input: { lens: 'expert', rescheduleProposal: liveProposal() },
        expected: 'reschedule_proposal_pending',
      },
      {
        name: 'live reschedule proposal SUPPRESSES upcoming',
        input: {
          rescheduleProposal: liveProposal(),
          nextScheduled: { meetingId: 'm1', scheduledStart: at(4320) },
        },
        expected: 'reschedule_proposal',
      },
      {
        name: 'EXPIRED reschedule proposal falls through to upcoming',
        input: {
          rescheduleProposal: liveProposal({ expiresAt: at(-5) }),
          nextScheduled: { meetingId: 'm1', scheduledStart: at(4320) },
        },
        expected: 'upcoming',
      },
      // ── arm 3: anything booked wins over the resolution ask ────────────────────────
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
      // ── arm 4: the ask, split by lens ─────────────────────────────────────────────
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
      // ── arm 5: the quiet default ──────────────────────────────────────────────────
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
   * already booked — it contradicts a commitment both parties made. It falls out of arm 3
   * sitting above arm 4, so this test is what stops someone "fixing" the ordering.
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

  it('carries the proposal fields straight through, both lenses', () => {
    const proposal = liveProposal({ proposalId: 'p-9', optionCount: 3 });

    expect(selectCaseNudge(nudgeInput({ rescheduleProposal: proposal }))).toEqual({
      kind: 'reschedule_proposal',
      proposalId: 'p-9',
      meetingId: proposal.meetingId,
      optionCount: 3,
      originalScheduledStart: proposal.originalScheduledStart,
      expiresAt: proposal.expiresAt,
    });

    expect(selectCaseNudge(nudgeInput({ lens: 'expert', rescheduleProposal: proposal }))).toEqual({
      kind: 'reschedule_proposal_pending',
      proposalId: 'p-9',
      meetingId: proposal.meetingId,
      optionCount: 3,
      expiresAt: proposal.expiresAt,
    });
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

describe('MEETING_OVERRUN_GRACE_MINUTES — BAL-513', () => {
  it('is 30 minutes', () => {
    expect(MEETING_OVERRUN_GRACE_MINUTES).toBe(30);
  });

  /**
   * BAL-513 fix round 2 (F8) — the PRIOR version of this test asserted
   * `MEETING_OVERRUN_GRACE_MINUTES * 60_000 < 24h`, which is trivially true (1,800,000 <
   * 86,400,000) and is NOT the constraint that actually governs whether a Join inside the grace
   * can succeed. An external review of PR #265 found the real governing relationship: the
   * lifecycle sweep's `idle_end` rule (`packages/shared/src/meetings/lifecycle.ts`) can end a
   * meeting — and tear down its Daily room — after `IDLE_END_EMPTY_MS` (5 minutes) of the room
   * sitting empty, which is SMALLER than this 30-minute grace. A naive reader could "fix" that
   * apparent contradiction by shrinking the grace to match; this test exists so a future reader
   * cannot do that without an assertion telling them why it would be wrong.
   */
  it('is DELIBERATELY LONGER than the idle-end timer — the room surviving idle_end is what makes that safe, not the reverse', () => {
    // ⚠⚠ THE GRACE IS SUPPOSED TO BE LONGER. `idle_end` only fires while the room has been EMPTY
    // for `IDLE_END_EMPTY_MS` (`roomEmptyPastWindow`, `lifecycle.ts`) — so for as long as ANYONE
    // remains in the room, `idle_end` never arms, the room stays open, and every one of the 30
    // grace minutes is real and joinable. The grace only outruns reality in the OTHER case: the
    // room already emptied and `idle_end` already fired (as early as +5 min from empty), tearing
    // the room down, while this calendar's frozen `status` still shows the meeting live for up to
    // ~20 more minutes of the 30. That gap is real — it is what BAL-513 fix round 2 (F7) closes
    // with a focus-triggered `router.refresh()` on the expert calendar, not by shrinking this
    // grace. Do NOT "fix" a future failure of this assertion by making the grace smaller; the
    // fix, if one is ever needed, is on the F7 side (the refresh path), or product-owned (the
    // grace duration itself).
    expect(MEETING_OVERRUN_GRACE_MINUTES * 60_000).toBeGreaterThan(IDLE_END_EMPTY_MS);
  });

  it('sanity bound only, NOT the governing one: the grace stays well inside the server TOKEN ceiling (24h)', () => {
    // Stated as a literal, not an import of `apps/api/src/services/meetings/meeting-liveness.ts`'s
    // `MEETING_TOKEN_TTL_AFTER_END_MS` — `packages/shared` must not import from `apps/api`. This
    // bound is generous by two orders of magnitude and was never the binding constraint; the test
    // above (`IDLE_END_EMPTY_MS`) is. Kept only so a future 24h-scale change to the grace does not
    // silently cross the token ceiling too.
    const SERVER_TOKEN_CEILING_MS = 24 * 60 * 60 * 1000;
    expect(MEETING_OVERRUN_GRACE_MINUTES * 60_000).toBeLessThan(SERVER_TOKEN_CEILING_MS);
  });
});

describe('deriveCaseConsultationState', () => {
  /**
   * TOTAL over every representable `(status, outcome, hasLiveRescheduleProposal)` triple.
   * `meeting_outcome_requires_ended` is one-directional, so `ended` + `null` IS legal and must
   * have its own honest state.
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

  it('is TOTAL — every (status, outcome, hasLiveRescheduleProposal) triple yields a label', () => {
    for (const status of STATUSES) {
      for (const outcome of OUTCOMES) {
        for (const hasLiveRescheduleProposal of [false, true]) {
          expect(
            typeof deriveCaseConsultationState({ status, outcome, hasLiveRescheduleProposal })
          ).toBe('string');
        }
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
  }>)('$status + $outcome → $expected (no live proposal)', ({ status, outcome, expected }) => {
    expect(deriveCaseConsultationState({ status, outcome, hasLiveRescheduleProposal: false })).toBe(
      expected
    );
  });

  /**
   * ⚠ BAL-411 — a live proposal flips ONLY the two `scheduled`-branch statuses to
   * `pending_reschedule`. Every other status/outcome combination is UNCHANGED by it — a
   * `cancelled` or `ended` row cannot legitimately carry a live proposal, but this function is
   * TOTAL and must still answer honestly if handed one (the guard sits inside the `scheduled`
   * branch precisely so it cannot).
   */
  it.each(['scheduled', 'waiting_for_participants'] as const)(
    'status=%s + a live reschedule proposal → pending_reschedule',
    (status) => {
      expect(
        deriveCaseConsultationState({ status, outcome: null, hasLiveRescheduleProposal: true })
      ).toBe('pending_reschedule');
    }
  );

  it.each([
    { status: 'in_progress', outcome: null },
    { status: 'ended', outcome: 'completed' },
    { status: 'ended', outcome: 'no_show_client' },
    { status: 'ended', outcome: 'missed_call' },
    { status: 'ended', outcome: null },
    { status: 'cancelled', outcome: null },
  ] as ReadonlyArray<{ status: MeetingStatusLabel; outcome: MeetingOutcomeLabel | null }>)(
    'a live reschedule proposal on a non-scheduled row ($status/$outcome) is IGNORED, never pending_reschedule',
    ({ status, outcome }) => {
      const withoutProposal = deriveCaseConsultationState({
        status,
        outcome,
        hasLiveRescheduleProposal: false,
      });
      const withProposal = deriveCaseConsultationState({
        status,
        outcome,
        hasLiveRescheduleProposal: true,
      });
      expect(withProposal).toBe(withoutProposal);
      expect(withProposal).not.toBe('pending_reschedule');
    }
  );

  /**
   * ⚠ THE TWO NO-SHOW OUTCOMES ARE DIFFERENT EVENTS AND MUST STAY DIFFERENT LABELS —
   * `no_show_client` means the expert waited; `missed_call` means the expert never joined.
   * Folding them would hide WHO failed to show, which is the row's load-bearing fact.
   */
  it('keeps no_show_client and missed_call DISTINCT', () => {
    const noShow = deriveCaseConsultationState({
      status: 'ended',
      outcome: 'no_show_client',
      hasLiveRescheduleProposal: false,
    });
    const missed = deriveCaseConsultationState({
      status: 'ended',
      outcome: 'missed_call',
      hasLiveRescheduleProposal: false,
    });
    expect(noShow).not.toBe(missed);
  });

  /** A cancelled meeting is cancelled whatever else the row happens to carry. */
  it('lets cancelled win over any outcome', () => {
    for (const outcome of OUTCOMES) {
      expect(
        deriveCaseConsultationState({
          status: 'cancelled',
          outcome,
          hasLiveRescheduleProposal: false,
        })
      ).toBe('cancelled');
    }
  });
});

describe('caseConsultationIsUpcoming', () => {
  it.each([
    { state: 'scheduled', upcoming: true },
    { state: 'pending_reschedule', upcoming: true },
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
