import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindById,
  mockFindIdByMeetingId,
  mockSettleFromPresence,
  mockFindMeetingById,
  mockSettlementFacts,
  mockFinalizeAndSettle,
  mockFinalizeBilling,
  mockCancel,
  mockMarkSessionless,
  mockResolveSubject,
  mockError,
  mockWarn,
  mockInfo,
  mockOnlyGuests,
  InvalidSessionTransitionErrorStub,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindIdByMeetingId: vi.fn(),
  mockSettleFromPresence: vi.fn(),
  mockFindMeetingById: vi.fn(),
  mockSettlementFacts: vi.fn(),
  mockFinalizeAndSettle: vi.fn(),
  mockFinalizeBilling: vi.fn(),
  mockCancel: vi.fn(),
  mockMarkSessionless: vi.fn(),
  mockResolveSubject: vi.fn(),
  mockError: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
  mockOnlyGuests: vi.fn(),
  // The real class is what `settle-from-presence.ts` tests with `instanceof` (R6F-10b).
  InvalidSessionTransitionErrorStub: class InvalidSessionTransitionError extends Error {},
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: mockError }),
}));
vi.mock('@balo/db', () => ({
  InvalidSessionTransitionError: InvalidSessionTransitionErrorStub,
  creditSessionsRepository: {
    findById: mockFindById,
    findIdByMeetingId: mockFindIdByMeetingId,
    settleFromPresence: mockSettleFromPresence,
    cancel: mockCancel,
    markSessionlessCaseMeeting: mockMarkSessionless,
  },
  meetingsRepository: { findById: mockFindMeetingById },
  meetingPresenceRepository: { settlementFacts: mockSettlementFacts },
}));
// BAL-412 (D5) — pin the floor so this suite is independent of any real env override.
vi.mock('../../config/billing-floor.js', () => ({
  resolveBillingFloorMs: () => 15 * 60_000,
  resolveBillingFloorMinutes: () => 15,
  // BAL-412 (F1) — the required upper bound this boundary injects (`MAX_SESSION_MINUTES`).
  resolveMaxBillableMinutes: () => 240,
}));
vi.mock('./end-session.js', () => ({ finalizeAndSettle: mockFinalizeAndSettle }));
// BAL-474 (D12.1c) — the closed-case release reads the billing subject.
vi.mock('./case-billing-subject.js', () => ({ resolveCaseBillingSubject: mockResolveSubject }));
vi.mock('./finalize-billing.js', () => ({ finalizeBilling: mockFinalizeBilling }));
// BAL-474 (R6F-4c) — the existing-session release reads the expert-invited-guest guard.
vi.mock('./expert-invited-guest-guard.js', () => ({
  onlyExpertInvitedGuestsAttended: mockOnlyGuests,
}));

import { settleSessionFromPresence, settleMeetingIfBillable } from './settle-from-presence.js';

const SESSION_ID = 'session-1';
const MEETING_ID = 'meeting-1';
const NOW = new Date('2026-08-20T10:30:00.000Z');
const START = new Date('2026-08-20T10:00:00.000Z');
const ENDED_AT = new Date('2026-08-20T10:20:00.000Z');

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    status: 'active',
    meetingId: MEETING_ID,
    expertProfileId: 'expert-1',
    durationSource: 'presence',
    billingFinalizedAt: null,
    lastTickSeq: 0,
    expertRateMinorPerMinute: 500,
    clientRateMinorPerMinute: 700,
    finalizationPath: null,
    settlementStatus: 'not_required',
    overdraftSettledMinor: null,
    ...overrides,
  };
}

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    status: 'ended',
    scheduledStart: START,
    endedAt: ENDED_AT,
    ...overrides,
  };
}

/** Both present for the full 20-minute call — the `held` shape. */
const HELD_CLOCKS = {
  expertPresentMs: 20 * 60_000,
  billableMs: 20 * 60_000,
  expertFirstJoinedAt: START,
  billableStartedAt: START,
};

describe('settleSessionFromPresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(session());
    mockFindMeetingById.mockResolvedValue(meeting());
    mockOnlyGuests.mockResolvedValue(false);
    mockResolveSubject.mockResolvedValue({ isActive: true, closedAt: null });
    mockCancel.mockResolvedValue({ id: SESSION_ID, status: 'cancelled' });
    mockMarkSessionless.mockResolvedValue({ markerId: 'marker-1', outcomeWritten: true });
    mockSettlementFacts.mockResolvedValue({
      clocks: HELD_CLOCKS,
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: HELD_CLOCKS.expertPresentMs,
      facts: { clientSideEverPresent: true },
    });
    mockSettleFromPresence.mockResolvedValue({
      session: session({ status: 'ended', billingFinalizedAt: NOW }),
      overdraftMinor: 0,
      expertAccruedMinor: 10_000,
      mandateActive: true,
      alreadySettled: false,
      ticksPosted: 20,
      outcomeWritten: true,
    });
    mockFinalizeAndSettle.mockResolvedValue({
      settlementStatus: 'not_required',
      overdraftSettledMinor: 0,
    });
  });

  it('refuses a missing session', async () => {
    mockFindById.mockResolvedValue(undefined);
    await expect(
      settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'session_not_found' });
    expect(mockSettleFromPresence).not.toHaveBeenCalled();
  });

  it('refuses an already-finalized session without recomputing anything', async () => {
    mockFindById.mockResolvedValue(session({ billingFinalizedAt: NOW }));
    await expect(
      settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'already_settled' });
    expect(mockFindMeetingById).not.toHaveBeenCalled();
    expect(mockSettleFromPresence).not.toHaveBeenCalled();
  });

  it('refuses a legacy already-ended row (NULL marker, pre-BAL-412 semantics)', async () => {
    mockFindById.mockResolvedValue(session({ status: 'ended', billingFinalizedAt: null }));
    await expect(
      settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'already_settled' });
  });

  it('refuses a non-presence session — the caller must not floor-settle live_capture/external', async () => {
    mockFindById.mockResolvedValue(session({ durationSource: 'live_capture' }));
    await expect(
      settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'not_presence_sourced' });
  });

  it('refuses a session with no meeting link', async () => {
    mockFindById.mockResolvedValue(session({ meetingId: null }));
    await expect(
      settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'no_meeting' });
  });

  it('refuses when the linked meeting cannot be found', async () => {
    mockFindMeetingById.mockResolvedValue(undefined);
    await expect(
      settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'no_meeting' });
  });

  it('refuses a meeting that has not terminated — D3 write-order precondition', async () => {
    mockFindMeetingById.mockResolvedValue(meeting({ status: 'in_progress' }));
    await expect(
      settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'meeting_not_terminal' });
    expect(mockSettlementFacts).not.toHaveBeenCalled();
  });

  it('resolves the held shape and settles via the shared post-commit tail', async () => {
    const result = await settleSessionFromPresence({
      sessionId: SESSION_ID,
      actorUserId: 'user-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.settlement.shape).toBe('held');
    expect(result.settlement.billableMinutes).toBe(20);

    expect(mockSettleFromPresence).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      meetingId: MEETING_ID,
      billableMinutes: 20,
      actualMinutes: 20,
      billingFloorMinutes: 15,
      topUpFromTickSeq: 1,
      topUpToTickSeq: 20,
      // F2 — the pre-read `lastTickSeq`, handed down as the TOCTOU anchor the repository
      // asserts under its row lock. Same value that fed `minutesAlreadyDrawn` in the core.
      minutesAlreadyDrawn: 0,
      shape: 'held',
      // F14 — the CORE's `floorApplied`, threaded rather than left for the repository to
      // re-derive as `billableMinutes > actualMinutes` (which is post-Q1-clamp).
      floorApplied: false,
      outcome: 'completed',
      actorUserId: 'user-1',
      now: expect.any(Date),
    });
    expect(mockFinalizeAndSettle).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID }),
      0,
      true,
      'presence',
      expect.any(Date)
    );
  });

  it('a never-joined expert settles at zero — missed_call, no Q1 log', async () => {
    mockSettlementFacts.mockResolvedValue({
      clocks: {
        expertPresentMs: 0,
        billableMs: 0,
        expertFirstJoinedAt: null,
        billableStartedAt: null,
      },
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: 0,
      facts: { clientSideEverPresent: false },
    });
    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.settlement.shape).toBe('missed_call');
    expect(result.settlement.billableMinutes).toBe(0);
    expect(mockSettleFromPresence).toHaveBeenCalledWith(
      expect.objectContaining({ billableMinutes: 0, topUpFromTickSeq: 1, topUpToTickSeq: 0 })
    );
    expect(mockError).not.toHaveBeenCalled();
  });

  it('⚠⚠ Q1 — logs at error when the no-refund clamp fires (drew more than presence justifies)', async () => {
    // Expert present only 5 of the 20 minutes, but 20 were already drawn (a dropped connection
    // while the client held the room open — the KNOWN LIMITATION named in the pure core).
    mockFindById.mockResolvedValue(session({ lastTickSeq: 20 }));
    mockSettlementFacts.mockResolvedValue({
      clocks: {
        expertPresentMs: 5 * 60_000,
        billableMs: 5 * 60_000,
        expertFirstJoinedAt: START,
        billableStartedAt: START,
      },
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: 5 * 60_000,
      facts: { clientSideEverPresent: true },
    });

    await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        meetingId: MEETING_ID,
        shape: 'held',
        ruleMinutes: 15,
        minutesAlreadyDrawn: 20,
        billableMinutes: 20,
      }),
      expect.stringContaining('no-refund rule')
    );
    // The clamp — never a refund. `topUpToTickSeq < topUpFromTickSeq` ⇒ nothing new posted.
    expect(mockSettleFromPresence).toHaveBeenCalledWith(
      expect.objectContaining({ billableMinutes: 20, topUpFromTickSeq: 21, topUpToTickSeq: 20 })
    );
  });

  it('⚠⚠ R1 — a client no-show hands the FLAT floor to the repository, not the expert’s wait', async () => {
    // Owner ruling, 2026-08-21: the client pays the 15-minute minimum and nothing more, however
    // long the expert waited. Asserted HERE, at the boundary, because this is where the figure
    // becomes a real off-session charge — a core-only test would not prove the service threads it.
    mockSettlementFacts.mockResolvedValue({
      clocks: {
        expertPresentMs: 40 * 60_000, // the expert left the tab open for 40 minutes
        billableMs: 0,
        expertFirstJoinedAt: START,
        billableStartedAt: null,
      },
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: 40 * 60_000,
      facts: { clientSideEverPresent: false },
    });

    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.settlement.shape).toBe('no_show_client');
    expect(result.settlement.actualMinutes).toBe(40);
    expect(result.settlement.billableMinutes).toBe(15);

    expect(mockSettleFromPresence).toHaveBeenCalledWith(
      expect.objectContaining({
        shape: 'no_show_client',
        billableMinutes: 15, // ⚠ NOT 40 — the client who never arrived pays the floor only
        actualMinutes: 40, // …and the real wait is still recorded, for the recap and forensics
        topUpFromTickSeq: 1,
        topUpToTickSeq: 15, // one figure drives both sides ⇒ the expert accrues 15 too
        floorApplied: true,
        outcome: 'no_show_client',
      })
    );
    // The F1 cap did not bind (15 ≪ 240) and no Q1 clamp fired, so nothing is logged at error.
    expect(mockError).not.toHaveBeenCalled();
  });

  it('⚠ R1 — an expert who abandons BELOW the floor settles at ZERO ("else, no charge")', async () => {
    mockSettlementFacts.mockResolvedValue({
      clocks: {
        expertPresentMs: 8 * 60_000,
        billableMs: 0,
        expertFirstJoinedAt: START,
        billableStartedAt: null,
      },
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: 8 * 60_000,
      facts: { clientSideEverPresent: false },
    });

    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.settlement.shape).toBe('abandoned_wait');
    expect(result.settlement.billableMinutes).toBe(0);
    expect(mockSettleFromPresence).toHaveBeenCalledWith(
      expect.objectContaining({ billableMinutes: 0, floorApplied: false })
    );
  });

  it('⚠⚠ F1 — a presence span past the cap settles AT the cap and logs at error', async () => {
    // THE EXPLOIT, EXACTLY: both join a 30-minute call, the client leaves at minute 2, the
    // expert leaves the Daily tab open for eight hours. No terminal rule fires (idle-end needs
    // an EMPTY room), so `expertPresentMs` is 480 minutes and `clientSideEverPresent` is true.
    mockSettlementFacts.mockResolvedValue({
      clocks: {
        expertPresentMs: 480 * 60_000,
        billableMs: 2 * 60_000,
        expertFirstJoinedAt: START,
        billableStartedAt: START,
      },
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: 480 * 60_000,
      facts: { clientSideEverPresent: true },
    });

    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.settlement.uncappedRuleMinutes).toBe(480);
    expect(result.settlement.billableMinutes).toBe(240); // AT the cap, not 480

    // The repository is never asked to post an unbillable figure.
    expect(mockSettleFromPresence).toHaveBeenCalledWith(
      expect.objectContaining({
        billableMinutes: 240,
        topUpFromTickSeq: 1,
        topUpToTickSeq: 240,
      })
    );
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        meetingId: MEETING_ID,
        shape: 'held',
        uncappedRuleMinutes: 480,
        maxBillableMinutes: 240,
        ruleMinutes: 240,
        billableMinutes: 240,
      }),
      expect.stringContaining('CAPPED at maxBillableMinutes')
    );
  });

  it('F1 — an ordinary settlement does NOT log the cap (it did not bind)', async () => {
    await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });
    expect(mockError).not.toHaveBeenCalled();
  });

  it('⚠ F15 — logs the success record plan §8.1 requires (this path ships INERT)', async () => {
    await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: 'user-1' });

    expect(mockInfo).toHaveBeenCalledWith(
      {
        sessionId: SESSION_ID,
        meetingId: MEETING_ID,
        shape: 'held',
        outcome: 'completed',
        actualMinutes: 20,
        billableMinutes: 20,
        floorApplied: false,
        ticksPosted: 20,
        overdraftMinor: 0,
      },
      'Presence settlement completed'
    );
  });

  it('⚠ F15 — logs the `outcomeWritten === false` case meetings.ts delegates to this caller', async () => {
    mockSettleFromPresence.mockResolvedValue({
      session: session({ status: 'ended', billingFinalizedAt: NOW }),
      overdraftMinor: 0,
      expertAccruedMinor: 10_000,
      mandateActive: true,
      alreadySettled: false,
      ticksPosted: 20,
      outcomeWritten: false,
    });

    await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(mockInfo).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, sessionId: SESSION_ID, outcome: 'completed' },
      'Outcome already resolved — settlement did not overwrite it'
    );
  });

  it('a TOCTOU race (repo alreadySettled) replays finalizeBilling instead of re-settling', async () => {
    mockSettleFromPresence.mockResolvedValue({
      session: session({
        status: 'ended',
        billingFinalizedAt: NOW,
        finalizationPath: 'presence',
        settlementStatus: 'not_required',
        overdraftSettledMinor: 0,
      }),
      overdraftMinor: 0,
      expertAccruedMinor: 10_000,
      mandateActive: true,
      alreadySettled: true,
      ticksPosted: 0,
      outcomeWritten: false,
    });

    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(result).toEqual({
      ok: true,
      settlement: expect.objectContaining({ shape: 'held' }),
      result: { settlementStatus: 'not_required', overdraftSettledMinor: 0 },
    });
    expect(mockFinalizeBilling).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID }),
      'presence',
      expect.any(Date)
    );
    // Never re-runs the shared post-commit tail — that would re-publish the settled receipt /
    // re-fire auto-top-up for a session somebody else already finalized.
    expect(mockFinalizeAndSettle).not.toHaveBeenCalled();
  });
});

describe('settleMeetingIfBillable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockFindById.mockResolvedValue(session());
    mockFindMeetingById.mockResolvedValue(meeting());
    mockSettlementFacts.mockResolvedValue({
      clocks: HELD_CLOCKS,
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: HELD_CLOCKS.expertPresentMs,
      facts: { clientSideEverPresent: true },
    });
    mockSettleFromPresence.mockResolvedValue({
      session: session({ status: 'ended', billingFinalizedAt: NOW }),
      overdraftMinor: 0,
      expertAccruedMinor: 10_000,
      mandateActive: true,
      alreadySettled: false,
      ticksPosted: 20,
      outcomeWritten: true,
    });
    mockFinalizeAndSettle.mockResolvedValue({
      settlementStatus: 'not_required',
      overdraftSettledMinor: 0,
    });
  });

  it('resolves `no_meeting` and touches nothing when the meeting has no session', async () => {
    mockFindIdByMeetingId.mockResolvedValue(undefined);
    await expect(
      settleMeetingIfBillable({ meetingId: MEETING_ID, actorUserId: null })
    ).resolves.toEqual({ ok: false, code: 'no_meeting' });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('delegates to settleSessionFromPresence with the resolved session id', async () => {
    const result = await settleMeetingIfBillable({ meetingId: MEETING_ID, actorUserId: 'user-1' });
    expect(result.ok).toBe(true);
    expect(mockFindById).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe('settleSessionFromPresence — Rule A: the pre-start time together, and the closed-case release (BAL-474)', () => {
  /** Both present 09:50–10:20 against a 10:00 start: 10 minutes together before it, 20 from it. */
  const NO_SHOW_CLOCKS = {
    expertPresentMs: 20 * 60_000,
    billableMs: 0,
    expertFirstJoinedAt: START,
    billableStartedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(session({ status: 'pending' }));
    mockFindMeetingById.mockResolvedValue(meeting());
    mockResolveSubject.mockResolvedValue({ isActive: true, closedAt: null });
    mockCancel.mockResolvedValue({ id: SESSION_ID, status: 'cancelled' });
    mockMarkSessionless.mockResolvedValue({ markerId: 'marker-1', outcomeWritten: true });
    mockSettleFromPresence.mockResolvedValue({
      session: session({ status: 'ended', billingFinalizedAt: NOW }),
      overdraftMinor: 0,
      expertAccruedMinor: 10_000,
      mandateActive: true,
      alreadySettled: false,
      ticksPosted: 30,
      outcomeWritten: true,
    });
    mockFinalizeAndSettle.mockResolvedValue({
      settlementStatus: 'not_required',
      overdraftSettledMinor: 0,
    });
  });

  it('⚠ reads the facts with the meeting’s scheduledStart and the SAME ceiling, and settles on the together term (10 + 20 = 30)', async () => {
    mockSettlementFacts.mockResolvedValue({
      clocks: HELD_CLOCKS,
      togetherBeforeStartMs: 10 * 60_000,
      expertPresentFromStartMs: HELD_CLOCKS.expertPresentMs,
      facts: { clientSideEverPresent: true },
    });

    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(mockSettlementFacts).toHaveBeenCalledWith(MEETING_ID, {
      scheduledStart: START,
      now: ENDED_AT,
      resolveExpertProfileId: expect.any(Function),
    });
    // R6F-4a — the lazy resolver answers with the SESSION's expert, so the repository can drop the guests that
    // expert invited from the together term.
    const [, facts] = mockSettlementFacts.mock.calls[0] as [
      string,
      { resolveExpertProfileId: () => Promise<string | null> },
    ];
    await expect(facts.resolveExpertProfileId()).resolves.toBe('expert-1');
    if (!result.ok) throw new Error('unreachable');
    expect(result.settlement.togetherBeforeStartMs).toBe(10 * 60_000);
    expect(result.settlement.actualMinutes).toBe(30);
    expect(result.settlement.billableMinutes).toBe(30);
  });

  it('⚠ D15.3 — bills together + the repository’s from-start figure, not the clamped clock: 30 + 50 = 80', async () => {
    mockSettlementFacts.mockResolvedValue({
      // The clamped clock anchors at the start and reads 60; the repository reports 50 from the return.
      clocks: { ...HELD_CLOCKS, expertPresentMs: 60 * 60_000, billableMs: 60 * 60_000 },
      togetherBeforeStartMs: 30 * 60_000,
      expertPresentFromStartMs: 50 * 60_000,
      facts: { clientSideEverPresent: true },
    });

    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    if (!result.ok) throw new Error('unreachable');
    expect(result.settlement.effectiveExpertPresentMs).toBe(50 * 60_000);
    expect(result.settlement.actualMinutes).toBe(80);
    expect(result.settlement.billableMinutes).toBe(80);
  });

  describe('a NO-SHOW on a case the client closed BEFORE the start owes nothing', () => {
    beforeEach(() => {
      mockSettlementFacts.mockResolvedValue({
        clocks: NO_SHOW_CLOCKS,
        togetherBeforeStartMs: 0,
        expertPresentFromStartMs: NO_SHOW_CLOCKS.expertPresentMs,
        facts: { clientSideEverPresent: false },
      });
    });

    it.each([
      ['a day before the start', new Date(START.getTime() - 86_400_000)],
      ['one millisecond before the start', new Date(START.getTime() - 1)],
      ['with no close instant recorded', null],
    ])(
      'closed %s ⇒ the session is released (cancel), the meeting marked not_billable, nothing settled',
      async (_label, closedAt) => {
        mockResolveSubject.mockResolvedValue({ isActive: false, closedAt });

        const result = await settleSessionFromPresence({
          sessionId: SESSION_ID,
          actorUserId: null,
          trigger: 'lifecycle_sweep',
        });

        expect(result).toEqual({ ok: false, code: 'released_closed_case_no_show' });
        expect(mockCancel).toHaveBeenCalledTimes(1);
        expect(mockCancel).toHaveBeenCalledWith(SESSION_ID, { memberId: undefined });
        expect(mockMarkSessionless).toHaveBeenCalledTimes(1);
        expect(mockMarkSessionless).toHaveBeenCalledWith({
          meetingId: MEETING_ID,
          disposition: 'not_billable',
          reason: 'case_closed_before_start',
          trigger: 'lifecycle_sweep',
          shape: 'no_show_client',
          outcome: 'no_show_client',
        });
        expect(mockSettleFromPresence).not.toHaveBeenCalled();
        expect(mockFinalizeAndSettle).not.toHaveBeenCalled();
        expect(mockInfo).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: SESSION_ID, meetingId: MEETING_ID }),
          expect.stringContaining('released')
        );
      }
    );

    it('the release is ordered: cancel FIRST, then the marker', async () => {
      mockResolveSubject.mockResolvedValue({ isActive: false, closedAt: null });
      await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });
      expect(mockCancel.mock.invocationCallOrder[0]).toBeLessThan(
        mockMarkSessionless.mock.invocationCallOrder[0] ?? 0
      );
    });

    it('closed EXACTLY at the start, or AFTER it ⇒ the floor is still owed (a client who resolves it while the expert waits)', async () => {
      for (const closedAt of [START, new Date(START.getTime() + 5 * 60_000)]) {
        vi.clearAllMocks();
        mockFindById.mockResolvedValue(session({ status: 'pending' }));
        mockFindMeetingById.mockResolvedValue(meeting());
        mockResolveSubject.mockResolvedValue({ isActive: false, closedAt });
        mockSettlementFacts.mockResolvedValue({
          clocks: NO_SHOW_CLOCKS,
          togetherBeforeStartMs: 0,
          expertPresentFromStartMs: NO_SHOW_CLOCKS.expertPresentMs,
          facts: { clientSideEverPresent: false },
        });
        mockSettleFromPresence.mockResolvedValue({
          session: session({ status: 'ended', billingFinalizedAt: NOW }),
          overdraftMinor: 0,
          expertAccruedMinor: 1,
          mandateActive: true,
          alreadySettled: false,
          ticksPosted: 15,
          outcomeWritten: true,
        });
        mockFinalizeAndSettle.mockResolvedValue({
          settlementStatus: 'not_required',
          overdraftSettledMinor: 0,
        });

        const result = await settleSessionFromPresence({
          sessionId: SESSION_ID,
          actorUserId: null,
        });

        expect(result.ok).toBe(true);
        expect(mockCancel).not.toHaveBeenCalled();
        expect(mockSettleFromPresence).toHaveBeenCalledTimes(1);
      }
    });

    it('an ACTIVE case is never released — a no-show owes the floor', async () => {
      mockResolveSubject.mockResolvedValue({ isActive: true, closedAt: null });
      mockSettleFromPresence.mockResolvedValue({
        session: session({ status: 'ended', billingFinalizedAt: NOW }),
        overdraftMinor: 0,
        expertAccruedMinor: 1,
        mandateActive: true,
        alreadySettled: false,
        ticksPosted: 15,
        outcomeWritten: true,
      });
      const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });
      expect(result.ok).toBe(true);
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it('a subject that cannot be resolved (not a Case) settles normally', async () => {
      mockResolveSubject.mockResolvedValue(undefined);
      await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockSettleFromPresence).toHaveBeenCalledTimes(1);
    });

    it('⚠ if the session is NOT pending (cancel throws InvalidSessionTransitionError) it logs at error and settles normally — never a silent release', async () => {
      mockResolveSubject.mockResolvedValue({ isActive: false, closedAt: null });
      mockCancel.mockRejectedValue(
        new InvalidSessionTransitionErrorStub('cannot cancel an active session')
      );
      mockSettleFromPresence.mockResolvedValue({
        session: session({ status: 'ended', billingFinalizedAt: NOW }),
        overdraftMinor: 0,
        expertAccruedMinor: 1,
        mandateActive: true,
        alreadySettled: false,
        ticksPosted: 15,
        outcomeWritten: true,
      });

      const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

      expect(result.ok).toBe(true);
      expect(mockError).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID }),
        expect.stringContaining('could not be released')
      );
      expect(mockMarkSessionless).not.toHaveBeenCalled();
      expect(mockSettleFromPresence).toHaveBeenCalledTimes(1);
    });

    it('any OTHER cancel failure propagates (the backstop retries) — and no marker is written', async () => {
      mockResolveSubject.mockResolvedValue({ isActive: false, closedAt: null });
      mockCancel.mockRejectedValue(new Error('db down'));
      await expect(
        settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null })
      ).rejects.toThrow('db down');
      expect(mockMarkSessionless).not.toHaveBeenCalled();
    });
  });

  it('⚠ D12.1(c) — an ATTENDED call (`held`) on a case closed before the start settles normally: a closure never voids it', async () => {
    mockResolveSubject.mockResolvedValue({ isActive: false, closedAt: null });
    mockSettlementFacts.mockResolvedValue({
      clocks: HELD_CLOCKS,
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: HELD_CLOCKS.expertPresentMs,
      facts: { clientSideEverPresent: true },
    });

    const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

    expect(result.ok).toBe(true);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockResolveSubject).not.toHaveBeenCalled();
    expect(mockSettleFromPresence).toHaveBeenCalledTimes(1);
  });

  /**
   * BAL-474 (R6F-4c, ADR-1040 Amendment 7 §E) — "not after the call": a `held` call whose ONLY client-side
   * attendees were guests the delivering expert invited is released and marked `not_billable`, with the same
   * reason the sessionless path writes — even though a session already existed.
   */
  describe('a HELD call attended only by guests the delivering expert invited (R6F-4c)', () => {
    beforeEach(() => {
      mockFindById.mockResolvedValue(session({ status: 'pending' }));
      mockSettlementFacts.mockResolvedValue({
        clocks: HELD_CLOCKS,
        togetherBeforeStartMs: 0,
        expertPresentFromStartMs: HELD_CLOCKS.expertPresentMs,
        facts: { clientSideEverPresent: true },
      });
      mockOnlyGuests.mockResolvedValue(true);
    });

    it('⚠⚠ releases the session, writes the not_billable marker with the sessionless reason, and settles nothing', async () => {
      const result = await settleSessionFromPresence({
        sessionId: SESSION_ID,
        actorUserId: null,
        trigger: 'lifecycle_sweep',
      });

      expect(result).toEqual({ ok: false, code: 'released_expert_invited_guest_only' });
      expect(mockOnlyGuests).toHaveBeenCalledWith(MEETING_ID, 'expert-1');
      expect(mockCancel).toHaveBeenCalledTimes(1);
      expect(mockMarkSessionless).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        disposition: 'not_billable',
        reason: 'expert_invited_guest_only',
        trigger: 'lifecycle_sweep',
        shape: 'held',
        outcome: 'completed',
      });
      expect(mockSettleFromPresence).not.toHaveBeenCalled();
      expect(mockFinalizeAndSettle).not.toHaveBeenCalled();
      // The sessionless path logs this case at `warn`; the release mirrors it.
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID, meetingId: MEETING_ID }),
        expect.stringContaining('guests the delivering expert invited')
      );
    });

    it('the release is ordered: cancel FIRST, then the marker', async () => {
      await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });
      expect(mockCancel.mock.invocationCallOrder[0]).toBeLessThan(
        mockMarkSessionless.mock.invocationCallOrder[0] ?? 0
      );
    });

    it('a call with a client MEMBER (or any non-guest attendee) is not released — the guard says no, it settles normally', async () => {
      mockOnlyGuests.mockResolvedValue(false);
      mockSettleFromPresence.mockResolvedValue({
        session: session({ status: 'ended', billingFinalizedAt: NOW }),
        overdraftMinor: 0,
        expertAccruedMinor: 1,
        mandateActive: true,
        alreadySettled: false,
        ticksPosted: 20,
        outcomeWritten: true,
      });

      const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

      expect(result.ok).toBe(true);
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockMarkSessionless).not.toHaveBeenCalled();
      expect(mockSettleFromPresence).toHaveBeenCalledTimes(1);
    });

    it('the guard is consulted ONLY on the `held` shape — a no-show never reads it', async () => {
      mockSettlementFacts.mockResolvedValue({
        clocks: NO_SHOW_CLOCKS,
        togetherBeforeStartMs: 0,
        expertPresentFromStartMs: NO_SHOW_CLOCKS.expertPresentMs,
        facts: { clientSideEverPresent: false },
      });
      mockResolveSubject.mockResolvedValue({ isActive: true, closedAt: null });
      mockSettleFromPresence.mockResolvedValue({
        session: session({ status: 'ended', billingFinalizedAt: NOW }),
        overdraftMinor: 0,
        expertAccruedMinor: 1,
        mandateActive: true,
        alreadySettled: false,
        ticksPosted: 15,
        outcomeWritten: true,
      });

      await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

      expect(mockOnlyGuests).not.toHaveBeenCalled();
    });

    it('⚠ a session that already CONNECTED cannot be cancelled: it logs at error and settles normally — never a silent release', async () => {
      mockCancel.mockRejectedValue(new InvalidSessionTransitionErrorStub('active → cancelled'));
      mockSettleFromPresence.mockResolvedValue({
        session: session({ status: 'ended', billingFinalizedAt: NOW }),
        overdraftMinor: 0,
        expertAccruedMinor: 1,
        mandateActive: true,
        alreadySettled: false,
        ticksPosted: 20,
        outcomeWritten: true,
      });

      const result = await settleSessionFromPresence({ sessionId: SESSION_ID, actorUserId: null });

      expect(result.ok).toBe(true);
      expect(mockError).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID }),
        expect.stringContaining('could not be released')
      );
      expect(mockMarkSessionless).not.toHaveBeenCalled();
    });
  });

  it('settleMeetingIfBillable threads the trigger through to the release marker', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: SESSION_ID });
    mockResolveSubject.mockResolvedValue({ isActive: false, closedAt: null });
    mockSettlementFacts.mockResolvedValue({
      clocks: NO_SHOW_CLOCKS,
      togetherBeforeStartMs: 0,
      expertPresentFromStartMs: NO_SHOW_CLOCKS.expertPresentMs,
      facts: { clientSideEverPresent: false },
    });

    await settleMeetingIfBillable({
      meetingId: MEETING_ID,
      actorUserId: null,
      trigger: 'human_end',
    });

    expect(mockMarkSessionless).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'human_end' })
    );
  });
});
