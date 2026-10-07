import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';

const {
  mockFindMeterable,
  mockFindWrappedIdle,
  mockFindStalePending,
  mockFindStuckSettling,
  mockFindFinalizedMissingPayout,
  mockFindPresenceCandidates,
  mockFindPendingForCancelledMeetings,
  mockFindSettledMissingLedgerCredit,
  mockCancel,
  mockDriveSession,
  mockEndSession,
  mockReconcile,
  mockFinalizeBilling,
  mockSettleSessionFromPresence,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerInfo,
  mockFindSessionlessEndedCaseMeetings,
  mockFindIdByMeetingId,
  mockSettleSessionlessCaseMeeting,
  mockExhaustSessionlessCaseMeeting,
  mockCaptureException,
  mockListDueToStartBilling,
  mockMeetingFindById,
  mockListOpen,
  mockStartBillingIfDue,
  mockFindPendingBeyondJoinWindow,
  mockMarkPresenceExhausted,
  MockSettlementRefusedError,
  MockSettlementDrawDivergedError,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  mockFindMeterable: vi.fn(),
  mockFindWrappedIdle: vi.fn(),
  mockFindStalePending: vi.fn(),
  mockFindStuckSettling: vi.fn(),
  mockFindFinalizedMissingPayout: vi.fn(),
  mockFindPresenceCandidates: vi.fn(),
  mockFindPendingForCancelledMeetings: vi.fn(),
  mockFindSettledMissingLedgerCredit: vi.fn(),
  mockCancel: vi.fn(),
  mockDriveSession: vi.fn(),
  mockEndSession: vi.fn(),
  mockReconcile: vi.fn(),
  mockFinalizeBilling: vi.fn(),
  mockSettleSessionFromPresence: vi.fn(),
  // ⚠ HOISTED so the no-silent-caps warns are ASSERTABLE. The module calls `createLogger`
  // once at import, so a factory that mints a fresh `vi.fn()` per call is unreachable here.
  mockLoggerWarn: vi.fn(),
  /** ⚠ HOISTED for the same reason as `mockLoggerWarn` — pass 7's per-row alarm is an `error`. */
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
  // BAL-474 — the sessionless-meeting backstop pass.
  mockFindSessionlessEndedCaseMeetings: vi.fn(),
  mockFindIdByMeetingId: vi.fn(),
  mockSettleSessionlessCaseMeeting: vi.fn(),
  mockExhaustSessionlessCaseMeeting: vi.fn(),
  mockCaptureException: vi.fn(),
  // BAL-474 (Rule A) — the billing-start pass and (D11.2) the beyond-window release pass.
  mockListDueToStartBilling: vi.fn(),
  mockMeetingFindById: vi.fn(),
  mockListOpen: vi.fn(),
  mockStartBillingIfDue: vi.fn(),
  mockFindPendingBeyondJoinWindow: vi.fn(),
  mockMarkPresenceExhausted: vi.fn(),
  // Real classes (not importActual, which would pull in the db client) so `instanceof` classifies.
  MockSettlementRefusedError: class SettlementRefusedError extends Error {
    constructor(
      readonly guard: string,
      message: string
    ) {
      super(message);
      this.name = 'SettlementRefusedError';
    }
  },
  MockSettlementDrawDivergedError: class SettlementDrawDivergedError extends Error {},
  /** The processor the mocked BullMQ `Worker` below receives from `startCreditSessionMeterSweepWorker`. */
  capturedWorkerProcessor: {
    fn: undefined as
      | ((job: { log: (message: string) => Promise<number> }) => Promise<void>)
      | undefined,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findMeterable: mockFindMeterable,
    findWrappedIdle: mockFindWrappedIdle,
    findStalePending: mockFindStalePending,
    findStuckSettling: mockFindStuckSettling,
    findFinalizedMissingPayout: mockFindFinalizedMissingPayout,
    findPresenceSettlementCandidates: mockFindPresenceCandidates,
    findPendingForCancelledMeetings: mockFindPendingForCancelledMeetings,
    findSettledMissingLedgerCredit: mockFindSettledMissingLedgerCredit,
    findSessionlessEndedCaseMeetings: mockFindSessionlessEndedCaseMeetings,
    findIdByMeetingId: mockFindIdByMeetingId,
    findPendingBeyondJoinWindow: mockFindPendingBeyondJoinWindow,
    markPresenceSettlementExhausted: mockMarkPresenceExhausted,
    cancel: mockCancel,
  },
  SettlementRefusedError: MockSettlementRefusedError,
  SettlementDrawDivergedError: MockSettlementDrawDivergedError,
  meetingsRepository: {
    listCaseMeetingsDueToStartBilling: mockListDueToStartBilling,
    findById: mockMeetingFindById,
  },
  meetingPresenceRepository: { listOpen: mockListOpen },
}));
vi.mock('../services/credit-session/start-billing.js', () => ({
  startBillingIfDue: mockStartBillingIfDue,
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
// BAL-474 — the service is mocked; its constants are restated here (its own test pins them).
vi.mock(
  '../services/credit-session/settle-sessionless-case-meeting.js',
  async (importOriginal) => ({
    // The window arithmetic is PURE and pinned by its own test; the sweep must use the real one.
    backstopWindowClosing: (
      await importOriginal<
        typeof import('../services/credit-session/settle-sessionless-case-meeting.js')
      >()
    ).backstopWindowClosing,
    SESSIONLESS_BACKSTOP_GRACE_MINUTES: 2,
    SESSIONLESS_BACKSTOP_WINDOW_HOURS: 72,
    SESSIONLESS_BACKSTOP_RETRY_HOURS: 25,
    SESSIONLESS_BACKSTOP_BATCH_LIMIT: 100,
    settleSessionlessCaseMeeting: mockSettleSessionlessCaseMeeting,
    exhaustSessionlessCaseMeeting: mockExhaustSessionlessCaseMeeting,
  })
);
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn() }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn() }));
// `startCreditSessionMeterSweepWorker` constructs a BullMQ Worker. The mock keeps its processor so
// the worker's completion summary runs for real, with no Redis connection.
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(
      _name: string,
      processor: (job: { log: (message: string) => Promise<number> }) => Promise<void>
    ) {
      capturedWorkerProcessor.fn = processor;
    }
  },
}));
vi.mock('../services/credit-session/index.js', () => ({
  driveSession: mockDriveSession,
  endSessionAsSystem: mockEndSession,
  reconcileStuckSettlement: mockReconcile,
  finalizeBilling: mockFinalizeBilling,
  settleSessionFromPresence: mockSettleSessionFromPresence,
}));

import {
  runSessionMeterSweep,
  startCreditSessionMeterSweepWorker,
} from './credit-session-meter-sweep.js';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session_1',
    status: 'active',
    initiatingMemberId: 'user_1',
    connectedAt: new Date(NOW.getTime() - 5 * 60_000),
    ...overrides,
  };
}

describe('runSessionMeterSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMeterable.mockResolvedValue([]);
    mockFindWrappedIdle.mockResolvedValue([]);
    mockFindStalePending.mockResolvedValue([]);
    mockFindStuckSettling.mockResolvedValue([]);
    mockFindFinalizedMissingPayout.mockResolvedValue([]);
    mockFindPresenceCandidates.mockResolvedValue([]);
    mockFindPendingForCancelledMeetings.mockResolvedValue([]);
    mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([]);
    mockFindIdByMeetingId.mockResolvedValue(undefined);
    mockListDueToStartBilling.mockResolvedValue([]);
    mockFindPendingBeyondJoinWindow.mockResolvedValue([]);
    mockStartBillingIfDue.mockResolvedValue({ kind: 'not_due' });
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'not_billable',
      reason: 'zero_shape',
    });
    mockDriveSession.mockImplementation(async (id: string) => ({
      session: activeSession({ id }),
      transitions: {},
      ticksPosted: 0,
    }));
  });

  it('meters every meterable session', async () => {
    mockFindMeterable.mockResolvedValue([activeSession({ id: 's1' }), activeSession({ id: 's2' })]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockDriveSession).toHaveBeenCalledTimes(2);
    expect(result.metered).toBe(2);
  });

  it('force-ends a session past MAX_SESSION_MINUTES', async () => {
    const stale = activeSession({
      connectedAt: new Date(NOW.getTime() - (MAX_SESSION_MINUTES + 1) * 60_000),
    });
    mockFindMeterable.mockResolvedValue([stale]);
    mockDriveSession.mockResolvedValue({ session: stale, transitions: {}, ticksPosted: 0 });
    await runSessionMeterSweep(NOW);
    expect(mockEndSession).toHaveBeenCalledWith('session_1', { now: NOW });
  });

  it('does not force-end a session within the cap', async () => {
    mockFindMeterable.mockResolvedValue([activeSession()]);
    await runSessionMeterSweep(NOW);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('auto-ends wrapped-idle sessions', async () => {
    mockFindWrappedIdle.mockResolvedValue([activeSession({ status: 'wrapped' })]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockEndSession).toHaveBeenCalledWith('session_1', { now: NOW });
    expect(result.ended).toBe(1);
  });

  it('auto-cancels stale-pending sessions', async () => {
    mockFindStalePending.mockResolvedValue([activeSession({ status: 'pending' })]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockCancel).toHaveBeenCalledWith('session_1');
    expect(result.cancelled).toBe(1);
  });

  it('reconciles stuck settlements', async () => {
    const stuck = activeSession({ status: 'ended', settlementStatus: 'processing' });
    mockFindStuckSettling.mockResolvedValue([stuck]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockReconcile).toHaveBeenCalledWith(stuck, { now: NOW });
    expect(result.reconciled).toBe(1);
  });

  it('isolates a per-row meter failure (batch continues)', async () => {
    mockFindMeterable.mockResolvedValue([activeSession({ id: 's1' }), activeSession({ id: 's2' })]);
    mockDriveSession.mockRejectedValueOnce(new Error('boom'));
    mockDriveSession.mockResolvedValueOnce({
      session: activeSession({ id: 's2' }),
      transitions: {},
      ticksPosted: 0,
    });
    const result = await runSessionMeterSweep(NOW);
    // s1 threw, s2 succeeded — the sweep does not abort.
    expect(result.metered).toBe(1);
  });

  // BAL-399 pass 5 — reconcile finalized sessions with no payout obligation booked.
  it('reconciles a stranded finalized session by replaying finalizeBilling with the persisted path', async () => {
    const stranded = activeSession({
      status: 'ended',
      billingFinalizedAt: new Date(NOW.getTime() - 10 * 60_000),
      finalizationPath: 'confirmed',
    });
    mockFindFinalizedMissingPayout.mockResolvedValue([stranded]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(1);
    expect(mockFinalizeBilling).toHaveBeenCalledWith(stranded, 'confirmed', NOW);
    expect(result.recovered).toBe(1);
    // The reconcile books the payout — it never re-drives the meter or re-settles.
    expect(mockDriveSession).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('defaults a null finalizationPath to live_capture on replay', async () => {
    const stranded = activeSession({
      status: 'ended',
      billingFinalizedAt: new Date(NOW.getTime() - 10 * 60_000),
      finalizationPath: null,
    });
    mockFindFinalizedMissingPayout.mockResolvedValue([stranded]);
    await runSessionMeterSweep(NOW);
    expect(mockFinalizeBilling).toHaveBeenCalledWith(stranded, 'live_capture', NOW);
  });

  it('is a no-op once the obligation is booked (finder returns nothing on the next sweep)', async () => {
    // First sweep recovers; the anti-join then no longer returns the row (payout now exists).
    mockFindFinalizedMissingPayout.mockResolvedValueOnce([
      activeSession({ id: 's1', status: 'ended', finalizationPath: 'live_capture' }),
    ]);
    mockFindFinalizedMissingPayout.mockResolvedValueOnce([]);
    const first = await runSessionMeterSweep(NOW);
    const second = await runSessionMeterSweep(NOW);
    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(1);
  });

  it('isolates a per-row finalizeBilling failure (batch continues, sweep does not abort)', async () => {
    mockFindFinalizedMissingPayout.mockResolvedValue([
      activeSession({ id: 's1', status: 'ended', finalizationPath: 'live_capture' }),
      activeSession({ id: 's2', status: 'ended', finalizationPath: 'live_capture' }),
    ]);
    mockFinalizeBilling.mockRejectedValueOnce(new Error('record failed'));
    mockFinalizeBilling.mockResolvedValueOnce(undefined);
    const result = await runSessionMeterSweep(NOW);
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(2); // both attempted
    expect(result.recovered).toBe(1); // s1 threw, s2 recovered
  });

  // BAL-412 (Q3) — a presence session is skipped by the force-end, not routed to endSessionAsSystem.
  it('skips the MAX_SESSION_MINUTES force-end for a presence-sourced session', async () => {
    const stale = activeSession({
      durationSource: 'presence',
      connectedAt: new Date(NOW.getTime() - (MAX_SESSION_MINUTES + 1) * 60_000),
    });
    mockFindMeterable.mockResolvedValue([stale]);
    mockDriveSession.mockResolvedValue({ session: stale, transitions: {}, ticksPosted: 0 });
    await runSessionMeterSweep(NOW);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  // BAL-412 (plan §4.3) — pass 6, the presence-settlement durability backstop.
  describe('presence-settlement durability backstop (pass 6)', () => {
    it('settles every presence-unsettled session the finder returns', async () => {
      mockFindPresenceCandidates.mockResolvedValue([
        activeSession({ id: 's1', durationSource: 'presence' }),
        activeSession({ id: 's2', durationSource: 'presence' }),
      ]);
      mockSettleSessionFromPresence.mockResolvedValue({ ok: true });
      const result = await runSessionMeterSweep(NOW);
      expect(mockSettleSessionFromPresence).toHaveBeenCalledTimes(2);
      expect(mockSettleSessionFromPresence).toHaveBeenCalledWith({
        sessionId: 's1',
        actorUserId: null,
        now: NOW,
      });
      expect(result.presenceSettled).toBe(2);
    });

    it('does not count a benign already_settled decline (a racing terminal path won)', async () => {
      mockFindPresenceCandidates.mockResolvedValue([
        activeSession({ id: 's1', durationSource: 'presence' }),
      ]);
      mockSettleSessionFromPresence.mockResolvedValue({ ok: false, code: 'already_settled' });
      const result = await runSessionMeterSweep(NOW);
      expect(result.presenceSettled).toBe(0);
    });

    it('isolates a per-row settlement failure (batch continues, sweep does not abort)', async () => {
      mockFindPresenceCandidates.mockResolvedValue([
        activeSession({ id: 's1', durationSource: 'presence' }),
        activeSession({ id: 's2', durationSource: 'presence' }),
      ]);
      mockSettleSessionFromPresence.mockRejectedValueOnce(new Error('boom'));
      mockSettleSessionFromPresence.mockResolvedValueOnce({ ok: true });
      const result = await runSessionMeterSweep(NOW);
      expect(mockSettleSessionFromPresence).toHaveBeenCalledTimes(2);
      expect(result.presenceSettled).toBe(1);
    });

    it('an empty finder result settles nothing (the ordinary case for most sweep ticks)', async () => {
      const result = await runSessionMeterSweep(NOW);
      expect(mockSettleSessionFromPresence).not.toHaveBeenCalled();
      expect(result.presenceSettled).toBe(0);
    });

    describe('permanent refusal marker', () => {
      const BATCH = 100;

      /**
       * Stateful fake of `findPresenceSettlementCandidates`: the first `limit` live ids in order,
       * minus any id already passed to the marker mock.
       */
      function installStatefulFinder(ids: string[]): void {
        const marked = new Set<string>();
        mockMarkPresenceExhausted.mockImplementation(async (input: { sessionId: string }) => {
          marked.add(input.sessionId);
          return { markerId: `marker_${input.sessionId}` };
        });
        mockFindPresenceCandidates.mockImplementation(async (_cutoff: Date, limit: number) =>
          ids
            .filter((id) => !marked.has(id))
            .slice(0, limit)
            .map((id) => activeSession({ id, durationSource: 'presence', meetingId: `m_${id}` }))
        );
      }

      it('a permanent refusal is marked once and drops out of the read, so a newer row settles on the next run (no starvation)', async () => {
        const refused = Array.from({ length: BATCH }, (_, i) => `refused_${i}`);
        installStatefulFinder([...refused, 'newer']);
        mockSettleSessionFromPresence.mockImplementation(async (input: { sessionId: string }) => {
          if (input.sessionId === 'newer') {
            return { ok: true };
          }
          throw new MockSettlementRefusedError('figure_exceeds_bound', 'refused');
        });

        const first = await runSessionMeterSweep(NOW);
        expect(mockMarkPresenceExhausted).toHaveBeenCalledTimes(BATCH);
        expect(mockSettleSessionFromPresence).toHaveBeenCalledTimes(BATCH);
        expect(mockSettleSessionFromPresence).not.toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'newer' })
        );
        expect(first.presenceSettled).toBe(0);

        const second = await runSessionMeterSweep(NOW);
        expect(mockMarkPresenceExhausted).toHaveBeenCalledTimes(BATCH);
        expect(mockSettleSessionFromPresence).toHaveBeenCalledTimes(BATCH + 1);
        expect(mockSettleSessionFromPresence).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: 'newer' })
        );
        expect(second.presenceSettled).toBe(1);
      });

      it('writes the marker with the guard, meeting id and message, and logs the exhaustion', async () => {
        installStatefulFinder(['s1']);
        mockSettleSessionFromPresence.mockRejectedValue(
          new MockSettlementRefusedError('meeting_mismatch', 'wrong meeting')
        );
        await runSessionMeterSweep(NOW);
        expect(mockMarkPresenceExhausted).toHaveBeenCalledWith({
          sessionId: 's1',
          meetingId: 'm_s1',
          guard: 'meeting_mismatch',
          error: 'wrong meeting',
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 's1', guard: 'meeting_mismatch' }),
          expect.stringContaining('permanently refused')
        );
      });

      it('SettlementDrawDivergedError is never marked and is retried on the next run', async () => {
        installStatefulFinder(['s1']);
        mockSettleSessionFromPresence.mockRejectedValue(
          new MockSettlementDrawDivergedError('diverged')
        );
        await runSessionMeterSweep(NOW);
        await runSessionMeterSweep(NOW);
        expect(mockMarkPresenceExhausted).not.toHaveBeenCalled();
        expect(mockSettleSessionFromPresence).toHaveBeenCalledTimes(2);
      });

      it('an unknown error is never marked', async () => {
        installStatefulFinder(['s1']);
        mockSettleSessionFromPresence.mockRejectedValue(new Error('connection reset'));
        await runSessionMeterSweep(NOW);
        expect(mockSettleSessionFromPresence).toHaveBeenCalledTimes(1);
        expect(mockMarkPresenceExhausted).not.toHaveBeenCalled();
      });

      it('a failing marker write is logged and never aborts the batch; the row is retried', async () => {
        installStatefulFinder(['s1', 's2']);
        mockMarkPresenceExhausted.mockRejectedValueOnce(new Error('audit write down'));
        mockSettleSessionFromPresence.mockImplementation(async (input: { sessionId: string }) => {
          if (input.sessionId === 's1') {
            throw new MockSettlementRefusedError('open_not_from_zero', 'refused');
          }
          return { ok: true };
        });
        const result = await runSessionMeterSweep(NOW);
        expect(mockSettleSessionFromPresence).toHaveBeenCalledTimes(2);
        expect(result.presenceSettled).toBe(1);
        expect(mockLoggerError).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 's1', error: 'audit write down' }),
          expect.stringContaining('marker')
        );
      });
    });
  });

  /**
   * BAL-410 — pass 3b, the CANCELLED-MEETING HOLD BACKSTOP.
   *
   * ⚠ THE IN-REQUEST RELEASE IS THE ONLY OTHER ACTOR, AND IT HAS NO SECOND CHANCE. Cancelling
   * removes the meeting from every reaper, so one transient failure in the cancel route strands
   * the hold PERMANENTLY and locks the company out of every future Case session.
   */
  describe('cancelled-meeting hold backstop (pass 3b)', () => {
    function pendingSession(id: string) {
      return { id, status: 'pending', durationSource: 'presence', meetingId: 'meeting_1' };
    }

    it('cancels every session the finder returns, and counts them', async () => {
      mockFindPendingForCancelledMeetings.mockResolvedValue([
        pendingSession('s1'),
        pendingSession('s2'),
      ]);

      const result = await runSessionMeterSweep(NOW);

      expect(mockCancel).toHaveBeenCalledTimes(2);
      expect(result.cancelledMeetingHolds).toBe(2);
    });

    it('⚠ passes `memberId: null` — the ADR-1030 system-actor exemption, never a fabricated actor', async () => {
      mockFindPendingForCancelledMeetings.mockResolvedValue([pendingSession('s1')]);

      await runSessionMeterSweep(NOW);

      expect(mockCancel).toHaveBeenCalledWith('s1', { memberId: null });
    });

    it('isolates a per-row failure — one bad row never stops the batch', async () => {
      mockFindPendingForCancelledMeetings.mockResolvedValue([
        pendingSession('s1'),
        pendingSession('s2'),
      ]);
      mockCancel.mockRejectedValueOnce(new Error('deadlock detected'));

      const result = await runSessionMeterSweep(NOW);

      expect(mockCancel).toHaveBeenCalledTimes(2);
      expect(result.cancelledMeetingHolds).toBe(1);
    });

    it('is a NO-OP when nothing is stranded — the expected steady state', async () => {
      mockFindPendingForCancelledMeetings.mockResolvedValue([]);

      const result = await runSessionMeterSweep(NOW);

      expect(mockCancel).not.toHaveBeenCalled();
      expect(result.cancelledMeetingHolds).toBe(0);
    });

    /**
     * ⚠ IT IS A SEPARATE PASS, NOT A WIDENING OF `findStalePending`. That finder EXCLUDES
     * `duration_source='presence'` to protect the no-show settlement of an ENDED meeting; this
     * one is scoped by the MEETING's status instead, so the two select disjoint rows and
     * neither can reach the other's.
     */
    it('runs its OWN finder, never the stale-pending one', async () => {
      mockFindPendingForCancelledMeetings.mockResolvedValue([pendingSession('s1')]);

      await runSessionMeterSweep(NOW);

      expect(mockFindPendingForCancelledMeetings).toHaveBeenCalledTimes(1);
      // …and the stale-pending finder still ran independently, on its own cutoff.
      expect(mockFindStalePending).toHaveBeenCalledTimes(1);
    });

    /**
     * ⚠⚠ NO SILENT CAPS — the same rule the presence pass states out loud. Calling the finder
     * BARE would take the repository's default limit and cap the tick invisibly, so a batch
     * that filled would read as "swept everything". A burst of cancellations during a DB blip
     * is exactly what this backstop is for, and exactly what queues more than one batch.
     */
    it('⚠ bounds the batch EXPLICITLY — never a bare call on the repository default', async () => {
      mockFindPendingForCancelledMeetings.mockResolvedValue([]);

      await runSessionMeterSweep(NOW);

      expect(mockFindPendingForCancelledMeetings).toHaveBeenCalledWith(100);
    });

    it('⚠ WARNS when the batch FILLS — stranded holds were dropped from this tick', async () => {
      const full = Array.from({ length: 100 }, (_unused, index) => pendingSession(`s${index}`));
      mockFindPendingForCancelledMeetings.mockResolvedValue(full);

      await runSessionMeterSweep(NOW);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100, oldestSessionId: 's0' }),
        expect.stringContaining('FILLED')
      );
    });

    it('does NOT warn about a full batch when the batch is short', async () => {
      mockFindPendingForCancelledMeetings.mockResolvedValue([pendingSession('s1')]);

      await runSessionMeterSweep(NOW);

      expect(mockLoggerWarn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('FILLED')
      );
    });
  });

  /**
   * Pass 7 — THE SETTLED-WITHOUT-CREDIT ALARM.
   *
   * ⚠ A session marked `settled` with no `overdraft_settlement` ledger row is money Stripe took,
   * a receivable cleared, dunning stopped, and NOTHING in the ledger to show for it — and the
   * client is shown "settled" (`settlement_status` is on the client allow-list). Post-fix this
   * pass returns 0 forever; it exists to surface rows already corrupted in production and to
   * fail loudly if a settled-without-credit write is ever reintroduced.
   */
  describe('settled-without-credit alarm (pass 7)', () => {
    function corruptSession(id: string) {
      return {
        id,
        walletId: 'wallet_1',
        companyId: 'company_1',
        settlementStatus: 'settled',
        settledAt: new Date(NOW.getTime() - 90 * 60_000),
        overdraftSettledMinor: 7600,
        stripePaymentIntentId: 'pi_lost',
      };
    }

    it('is silent and counts 0 in the expected steady state', async () => {
      const result = await runSessionMeterSweep(NOW);

      expect(result.settledMissingCredit).toBe(0);
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it('raises ONE batched log.error per tick naming every session, and counts every row', async () => {
      // Per-ROW errors turned one stuck row into 1,440 identical error records a day (the sweep
      // is per-minute and each row needs a human resend). One record per tick carries the same
      // identifiers without the flood.
      mockFindSettledMissingLedgerCredit.mockResolvedValue([
        corruptSession('s1'),
        corruptSession('s2'),
      ]);

      const result = await runSessionMeterSweep(NOW);

      expect(result.settledMissingCredit).toBe(2);
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          count: 2,
          sessions: [
            expect.objectContaining({ sessionId: 's1', stripePaymentIntentId: 'pi_lost' }),
            expect.objectContaining({ sessionId: 's2', stripePaymentIntentId: 'pi_lost' }),
          ],
        }),
        expect.stringContaining('NO overdraft_settlement ledger credit')
      );
    });

    it('stays SILENT on a clean tick — no empty-batch error record', async () => {
      mockFindSettledMissingLedgerCredit.mockResolvedValue([]);

      const result = await runSessionMeterSweep(NOW);

      expect(result.settledMissingCredit).toBe(0);
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    /**
     * ⚠ ALARM ONLY. The repair belongs where the evidence is about to be erased
     * (`markSettledFromReconcile`, which now verifies the credit and applies it before anything
     * is marked or cleared), with a proven-succeeded PaymentIntent in hand. A sweep firing an
     * hour later would be repairing from strictly weaker evidence.
     */
    it('WRITES NOTHING — it never ends, cancels, reconciles or re-finalizes a reported row', async () => {
      mockFindSettledMissingLedgerCredit.mockResolvedValue([corruptSession('s1')]);

      await runSessionMeterSweep(NOW);

      expect(mockEndSession).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockFinalizeBilling).not.toHaveBeenCalled();
      expect(mockSettleSessionFromPresence).not.toHaveBeenCalled();
    });

    it('⚠ bounds the batch EXPLICITLY — never a bare call on the repository default', async () => {
      await runSessionMeterSweep(NOW);

      expect(mockFindSettledMissingLedgerCredit).toHaveBeenCalledWith(expect.any(Date), 100);
    });

    it('uses a 60-minute cutoff so an in-flight reconcile is never reported as corruption', async () => {
      await runSessionMeterSweep(NOW);

      const [cutoff] = mockFindSettledMissingLedgerCredit.mock.calls[0] as [Date, number];
      expect(cutoff).toEqual(new Date(NOW.getTime() - 60 * 60_000));
    });

    it('⚠ WARNS when the batch FILLS — further corrupted rows were dropped from this tick', async () => {
      const full = Array.from({ length: 100 }, (_unused, index) => corruptSession(`s${index}`));
      mockFindSettledMissingLedgerCredit.mockResolvedValue(full);

      await runSessionMeterSweep(NOW);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100, oldestSessionId: 's0' }),
        expect.stringContaining('FILLED')
      );
    });
  });

  describe("the worker's job.log completion summary", () => {
    function startedProcessor(): (job: {
      log: (message: string) => Promise<number>;
    }) => Promise<void> {
      startCreditSessionMeterSweepWorker();
      const processor = capturedWorkerProcessor.fn;
      if (processor === undefined) {
        throw new Error('Worker processor was never captured — the bullmq mock did not fire');
      }
      return processor;
    }

    it('logs the completion summary via job.log', async () => {
      const jobLog = vi.fn().mockResolvedValue(1);
      await startedProcessor()({ log: jobLog });
      expect(jobLog).toHaveBeenLastCalledWith(
        'session meter sweep: 0 billing-started, 0 beyond-window-released, 0 metered, 0 ended, 0 cancelled, 0 reconciled, 0 recovered, 0 sessionless-settled, 0 presence-settled, 0 settled-without-credit'
      );
    });

    it('awaits the summary write, so a failed write fails the job rather than floating', async () => {
      const jobLog = vi.fn((message: string) =>
        message.startsWith('session meter sweep:')
          ? Promise.reject(new Error('redis unavailable'))
          : Promise.resolve(1)
      );
      await expect(startedProcessor()({ log: jobLog })).rejects.toThrow('redis unavailable');
    });
  });
});

// ── BAL-474 (ADR-1040 Amendment 7 §D, D5.4, D5.5, D7.5, V4-F3, V4-F4) ────────────────────────────────

describe('runSessionMeterSweep — the sessionless-meeting backstop (pass 5b, BAL-474)', () => {
  const HOUR = 60 * 60_000;

  function candidate(id: string, endedHoursAgo: number) {
    return {
      meetingId: id,
      scheduledStart: new Date(NOW.getTime() - (endedHoursAgo + 1) * HOUR),
      endedAt: new Date(NOW.getTime() - endedHoursAgo * HOUR),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMeterable.mockResolvedValue([]);
    mockFindWrappedIdle.mockResolvedValue([]);
    mockFindStalePending.mockResolvedValue([]);
    mockFindStuckSettling.mockResolvedValue([]);
    mockFindFinalizedMissingPayout.mockResolvedValue([]);
    mockFindPresenceCandidates.mockResolvedValue([]);
    mockFindPendingForCancelledMeetings.mockResolvedValue([]);
    mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([]);
    mockFindIdByMeetingId.mockResolvedValue(undefined);
    mockListDueToStartBilling.mockResolvedValue([]);
    mockFindPendingBeyondJoinWindow.mockResolvedValue([]);
    mockStartBillingIfDue.mockResolvedValue({ kind: 'not_due' });
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'not_billable',
      reason: 'zero_shape',
    });
    mockExhaustSessionlessCaseMeeting.mockResolvedValue(undefined);
  });

  it('asks the finder for meetings ended ≥ 2 minutes ago, inside the 72h window on BOTH columns, with an EXPLICIT limit of 100', async () => {
    await runSessionMeterSweep(NOW);
    expect(mockFindSessionlessEndedCaseMeetings).toHaveBeenCalledWith({
      endedBefore: new Date(NOW.getTime() - 2 * 60_000),
      windowStart: new Date(NOW.getTime() - 72 * HOUR),
      limit: 100,
    });
  });

  it('runs the backstop with the `backstop` trigger and the system actor, and counts only opened_and_settled', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([
      candidate('m1', 1),
      candidate('m2', 1),
      candidate('m3', 1),
    ]);
    mockSettleSessionlessCaseMeeting
      .mockResolvedValueOnce({
        kind: 'opened_and_settled',
        sessionId: 's1',
        toleratedGates: [],
        outcome: { ok: true },
      })
      .mockResolvedValueOnce({ kind: 'not_billable', reason: 'zero_shape' })
      .mockResolvedValueOnce({ kind: 'settled_existing_session', outcome: { ok: false } });

    const result = await runSessionMeterSweep(NOW);

    expect(result.sessionlessMeetingsSettled).toBe(1);
    expect(mockSettleSessionlessCaseMeeting).toHaveBeenCalledWith({
      meetingId: 'm1',
      trigger: 'backstop',
      actorUserId: null,
      now: NOW,
    });
    expect(mockExhaustSessionlessCaseMeeting).not.toHaveBeenCalled();
  });

  it('a deferral inside the 25h retry window is left for the next tick — no marker, no alert', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([candidate('m1', 24)]);
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'deferred',
      reason: 'session_in_progress',
      outcome: 'no_show_client',
    });
    await runSessionMeterSweep(NOW);
    expect(mockExhaustSessionlessCaseMeeting).not.toHaveBeenCalled();
  });

  it('⚠ D7.5 — the FIRST attempt past 25h exhausts a deferral, whenever that attempt runs (a missed-tick gap changes nothing)', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([candidate('m1', 30)]);
    mockSettleSessionlessCaseMeeting.mockResolvedValue({
      kind: 'deferred',
      reason: 'session_in_progress',
      outcome: 'no_show_client',
    });
    await runSessionMeterSweep(NOW);
    expect(mockExhaustSessionlessCaseMeeting).toHaveBeenCalledTimes(1);
    expect(mockExhaustSessionlessCaseMeeting).toHaveBeenCalledWith({
      meetingId: 'm1',
      reason: 'session_in_progress',
      trigger: 'backstop',
      outcome: 'no_show_client',
    });
  });

  describe('⚠ D10.2 — exhaustion ALSO fires when the finder is about to drop the row', () => {
    const deferred = {
      kind: 'deferred',
      reason: 'session_in_progress',
      outcome: 'no_show_client',
    } as const;
    /** A meeting that started `startedHoursAgo` ago but only ENDED `endedHoursAgo` ago (a late End). */
    function lateEnded(id: string, startedHoursAgo: number, endedHoursAgo: number) {
      return {
        meetingId: id,
        scheduledStart: new Date(NOW.getTime() - startedHoursAgo * HOUR),
        endedAt: new Date(NOW.getTime() - endedHoursAgo * HOUR),
      };
    }

    it('a late-ended meeting (ended 2h ago, started 71.5h ago) is exhausted on a deferral — it has no further tick', async () => {
      mockFindSessionlessEndedCaseMeetings.mockResolvedValue([lateEnded('m1', 71.5, 2)]);
      mockSettleSessionlessCaseMeeting.mockResolvedValue(deferred);
      await runSessionMeterSweep(NOW);
      expect(mockExhaustSessionlessCaseMeeting).toHaveBeenCalledWith({
        meetingId: 'm1',
        reason: 'session_in_progress',
        trigger: 'backstop',
        outcome: 'no_show_client',
      });
    });

    it('the boundary: started 71h ago exhausts; started just under 71h ago is left for the next tick', async () => {
      mockFindSessionlessEndedCaseMeetings.mockResolvedValue([
        lateEnded('edge', 71, 2),
        lateEnded('inside', 70.99, 2),
      ]);
      mockSettleSessionlessCaseMeeting.mockResolvedValue(deferred);
      await runSessionMeterSweep(NOW);
      expect(mockExhaustSessionlessCaseMeeting).toHaveBeenCalledTimes(1);
      expect(mockExhaustSessionlessCaseMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: 'edge' })
      );
    });

    it('a THROWN attempt in the last hour that billed nothing is exhausted with reason `error`', async () => {
      mockFindSessionlessEndedCaseMeetings.mockResolvedValue([lateEnded('m1', 71.5, 2)]);
      mockSettleSessionlessCaseMeeting.mockRejectedValue(new Error('db down'));
      await runSessionMeterSweep(NOW);
      expect(mockExhaustSessionlessCaseMeeting).toHaveBeenCalledWith({
        meetingId: 'm1',
        reason: 'error',
        trigger: 'backstop',
      });
    });
  });

  it('warns when the batch FILLS — no silent cap on a money backstop', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => candidate(`m${String(index)}`, 1))
    );
    await runSessionMeterSweep(NOW);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, oldestMeetingId: 'm0' }),
      expect.stringContaining('Sessionless-meeting batch FILLED')
    );
  });

  it('a THROWN attempt inside the retry window is logged and retried next tick — one bad row never stops the batch', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([
      candidate('bad', 1),
      candidate('good', 1),
    ]);
    mockSettleSessionlessCaseMeeting
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce({
        kind: 'opened_and_settled',
        sessionId: 's2',
        toleratedGates: [],
        outcome: { ok: true },
      });

    const result = await runSessionMeterSweep(NOW);

    expect(result.sessionlessMeetingsSettled).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'bad', error: 'db blip' }),
      'Sessionless-meeting backstop attempt failed'
    );
    expect(mockExhaustSessionlessCaseMeeting).not.toHaveBeenCalled();
  });

  it('⚠ a THROWN attempt past 25h that billed NOTHING is exhausted (reason `error`)', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([candidate('m1', 30)]);
    mockSettleSessionlessCaseMeeting.mockRejectedValue(new Error('db down'));
    mockFindIdByMeetingId.mockResolvedValue(undefined);

    await runSessionMeterSweep(NOW);

    expect(mockFindIdByMeetingId).toHaveBeenCalledWith('m1');
    expect(mockExhaustSessionlessCaseMeeting).toHaveBeenCalledWith({
      meetingId: 'm1',
      reason: 'error',
      trigger: 'backstop',
    });
  });

  it('⚠ V4-F3 — a tail throw AFTER a committed open-and-settle writes NO marker and raises NO alert (the consultation IS billed)', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([candidate('m1', 30)]);
    const failure = new Error('finalizeAndSettle failed');
    mockSettleSessionlessCaseMeeting.mockRejectedValue(failure);
    // The open-and-settle committed before the tail threw, so a session now exists.
    mockFindIdByMeetingId.mockResolvedValue({ id: 'session-committed' });

    await runSessionMeterSweep(NOW);

    expect(mockExhaustSessionlessCaseMeeting).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'm1', error: 'finalizeAndSettle failed' }),
      expect.stringContaining('post-commit tail failed')
    );
    expect(mockCaptureException).toHaveBeenCalledWith(failure, expect.anything());
  });

  it('a failure while RECORDING the failure (the re-read or the exhaustion) is logged and never escapes the tick', async () => {
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([candidate('m1', 30)]);
    mockSettleSessionlessCaseMeeting.mockRejectedValue(new Error('db down'));
    mockExhaustSessionlessCaseMeeting.mockRejectedValue(new Error('marker write failed'));

    await expect(runSessionMeterSweep(NOW)).resolves.toBeDefined();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'm1', error: 'marker write failed' }),
      expect.stringContaining('could not record its failure')
    );
  });

  it('runs BEFORE the presence-unsettled pass — a session it opens-and-settles is finalized in the same call', async () => {
    await runSessionMeterSweep(NOW);
    expect(mockFindSessionlessEndedCaseMeetings.mock.invocationCallOrder[0]).toBeLessThan(
      mockFindPresenceCandidates.mock.invocationCallOrder[0] ?? 0
    );
  });
});

describe('runSessionMeterSweep — every pass is isolated (BAL-474, V4-F4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMeterable.mockResolvedValue([]);
    mockFindWrappedIdle.mockResolvedValue([]);
    mockFindStalePending.mockResolvedValue([]);
    mockFindStuckSettling.mockResolvedValue([]);
    mockFindFinalizedMissingPayout.mockResolvedValue([]);
    mockFindPresenceCandidates.mockResolvedValue([]);
    mockFindPendingForCancelledMeetings.mockResolvedValue([]);
    mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([]);
  });

  it('⚠ an EARLIER pass throwing still runs the sessionless backstop and every pass behind it', async () => {
    mockFindMeterable.mockRejectedValue(new Error('meter finder down'));
    mockFindFinalizedMissingPayout.mockRejectedValue(new Error('payout finder down'));

    const result = await runSessionMeterSweep(NOW);

    expect(mockFindSessionlessEndedCaseMeetings).toHaveBeenCalledTimes(1);
    expect(mockFindPresenceCandidates).toHaveBeenCalledTimes(1);
    expect(mockFindSettledMissingLedgerCredit).toHaveBeenCalledTimes(1);
    // A broken pass counts 0 — never a partial figure.
    expect(result.metered).toBe(0);
    expect(result.recovered).toBe(0);
  });

  it('a broken pass stays LOUD — error log with the pass name AND Sentry — and the tick does not throw', async () => {
    const failure = new Error('meter finder down');
    mockFindMeterable.mockRejectedValue(failure);
    const logged: string[] = [];

    await expect(
      runSessionMeterSweep(NOW, (message) => logged.push(message))
    ).resolves.toBeDefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ pass: 'meter', error: 'meter finder down' }),
      expect.stringContaining('Meter sweep pass failed')
    );
    expect(mockCaptureException).toHaveBeenCalledWith(failure, { extra: { pass: 'meter' } });
    expect(logged.some((line) => line.includes('meter'))).toBe(true);
  });

  it('the pass-7 finder throwing no longer fails the job — it is isolated like every other pass', async () => {
    mockFindSettledMissingLedgerCredit.mockRejectedValue(new Error('finder down'));
    const result = await runSessionMeterSweep(NOW);
    expect(result.settledMissingCredit).toBe(0);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ pass: 'settled_missing_credit' }),
      expect.any(String)
    );
  });
});

describe('runSessionMeterSweep — the billing-start pass (pass 0, BAL-474 Rule A)', () => {
  const HOUR = 3_600_000;
  const due = (id: string) => ({ meetingId: id, scheduledStart: new Date(NOW.getTime() - HOUR) });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMeterable.mockResolvedValue([]);
    mockFindWrappedIdle.mockResolvedValue([]);
    mockFindStalePending.mockResolvedValue([]);
    mockFindStuckSettling.mockResolvedValue([]);
    mockFindFinalizedMissingPayout.mockResolvedValue([]);
    mockFindPresenceCandidates.mockResolvedValue([]);
    mockFindPendingForCancelledMeetings.mockResolvedValue([]);
    mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([]);
    mockFindPendingBeyondJoinWindow.mockResolvedValue([]);
    mockListDueToStartBilling.mockResolvedValue([]);
    mockMeetingFindById.mockImplementation(async (id: string) => ({ id, status: 'in_progress' }));
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);
    mockStartBillingIfDue.mockResolvedValue({ kind: 'started', sessionId: 's', opened: false });
  });

  it('asks the finder for meetings due at `now`, with an EXPLICIT batch limit of 100', async () => {
    await runSessionMeterSweep(NOW);
    expect(mockListDueToStartBilling).toHaveBeenCalledWith({ now: NOW, limit: 100 });
  });

  it('hands each due meeting to the seam with ITS meeting row, ITS open rows and `now`, and counts only STARTED meters', async () => {
    mockListDueToStartBilling.mockResolvedValue([due('m1'), due('m2'), due('m3')]);
    mockStartBillingIfDue
      .mockResolvedValueOnce({ kind: 'started', sessionId: 's1', opened: true })
      .mockResolvedValueOnce({ kind: 'already_metering', sessionId: 's2' })
      .mockResolvedValueOnce({ kind: 'deferred', reason: 'session_in_progress' });

    const result = await runSessionMeterSweep(NOW);

    expect(result.billingStarted).toBe(1);
    expect(mockStartBillingIfDue).toHaveBeenCalledTimes(3);
    expect(mockStartBillingIfDue).toHaveBeenNthCalledWith(1, {
      meeting: { id: 'm1', status: 'in_progress' },
      openRows: [{ party: 'expert' }, { party: 'client' }],
      now: NOW,
    });
    expect(mockListOpen).toHaveBeenCalledWith('m1');
  });

  it('⚠ runs FIRST — before the meter pass, so a session it connects is metered in the same run', async () => {
    await runSessionMeterSweep(NOW);
    expect(mockListDueToStartBilling.mock.invocationCallOrder[0]).toBeLessThan(
      mockFindMeterable.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('warns when the batch FILLS — no silent cap on a money pass', async () => {
    mockListDueToStartBilling.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => due(`m${String(index)}`))
    );
    await runSessionMeterSweep(NOW);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, oldestMeetingId: 'm0' }),
      expect.stringContaining('Billing-start batch FILLED')
    );
  });

  it('a meeting that vanished between the finder and the read is skipped; a THROWING row never stops the batch', async () => {
    mockListDueToStartBilling.mockResolvedValue([due('gone'), due('bad'), due('good')]);
    mockMeetingFindById.mockImplementation(async (id: string) =>
      id === 'gone' ? undefined : { id, status: 'in_progress' }
    );
    mockListOpen.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('db blip');
      return [];
    });

    const result = await runSessionMeterSweep(NOW);

    expect(result.billingStarted).toBe(1);
    expect(mockStartBillingIfDue).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'bad', error: 'db blip' }),
      'Billing-start pass failed for a meeting'
    );
  });

  it('⚠ a pass that THROWS is isolated: it counts 0 and every pass behind it still runs (V4-F4)', async () => {
    mockListDueToStartBilling.mockRejectedValue(new Error('finder down'));
    const result = await runSessionMeterSweep(NOW);
    expect(result.billingStarted).toBe(0);
    expect(mockFindMeterable).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('runSessionMeterSweep — the beyond-window release pass (pass 0b, BAL-474 D11.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMeterable.mockResolvedValue([]);
    mockFindWrappedIdle.mockResolvedValue([]);
    mockFindStalePending.mockResolvedValue([]);
    mockFindStuckSettling.mockResolvedValue([]);
    mockFindFinalizedMissingPayout.mockResolvedValue([]);
    mockFindPresenceCandidates.mockResolvedValue([]);
    mockFindPendingForCancelledMeetings.mockResolvedValue([]);
    mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([]);
    mockListDueToStartBilling.mockResolvedValue([]);
    mockFindPendingBeyondJoinWindow.mockResolvedValue([]);
    mockCancel.mockResolvedValue({ id: 'x', status: 'cancelled' });
  });

  it('asks for pending sessions whose meeting starts beyond the 3-minute join window (D16), batch-bounded', async () => {
    await runSessionMeterSweep(NOW);
    expect(mockFindPendingBeyondJoinWindow).toHaveBeenCalledWith({
      now: NOW,
      windowMs: 3 * 60_000,
      limit: 100,
    });
  });

  it('cancels each one, stamping the PLACER (the session’s initiating member), and counts what it released', async () => {
    mockFindPendingBeyondJoinWindow.mockResolvedValue([
      { id: 's1', meetingId: 'm1', initiatingMemberId: 'user-a' },
      { id: 's2', meetingId: 'm2', initiatingMemberId: 'user-b' },
    ]);

    const result = await runSessionMeterSweep(NOW);

    expect(result.beyondWindowReleased).toBe(2);
    expect(mockCancel).toHaveBeenCalledWith('s1', { memberId: 'user-a' });
    expect(mockCancel).toHaveBeenCalledWith('s2', { memberId: 'user-b' });
  });

  it('a failing cancel is logged with its stack context and never stops the batch', async () => {
    mockFindPendingBeyondJoinWindow.mockResolvedValue([
      { id: 's1', meetingId: 'm1', initiatingMemberId: 'user-a' },
      { id: 's2', meetingId: 'm2', initiatingMemberId: 'user-b' },
    ]);
    mockCancel.mockRejectedValueOnce(new Error('lock timeout')).mockResolvedValueOnce({});

    const result = await runSessionMeterSweep(NOW);

    expect(result.beyondWindowReleased).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', error: 'lock timeout' }),
      'Beyond-window pending session could not be released'
    );
  });

  it('runs AFTER the billing-start pass and BEFORE the meter pass', async () => {
    await runSessionMeterSweep(NOW);
    const [start] = mockListDueToStartBilling.mock.invocationCallOrder;
    const [beyond] = mockFindPendingBeyondJoinWindow.mock.invocationCallOrder;
    const [meter] = mockFindMeterable.mock.invocationCallOrder;
    expect(start).toBeLessThan(beyond ?? 0);
    expect(beyond).toBeLessThan(meter ?? 0);
  });
});

describe('runSessionMeterSweep — pass 6 treats `released_closed_case_no_show` as TERMINAL (BAL-474, D12.1c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMeterable.mockResolvedValue([]);
    mockFindWrappedIdle.mockResolvedValue([]);
    mockFindStalePending.mockResolvedValue([]);
    mockFindStuckSettling.mockResolvedValue([]);
    mockFindFinalizedMissingPayout.mockResolvedValue([]);
    mockFindPendingForCancelledMeetings.mockResolvedValue([]);
    mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
    mockFindSessionlessEndedCaseMeetings.mockResolvedValue([]);
    mockFindPendingBeyondJoinWindow.mockResolvedValue([]);
    mockListDueToStartBilling.mockResolvedValue([]);
    mockFindPresenceCandidates.mockResolvedValue([{ id: 'session_9' }]);
  });

  it.each(['released_closed_case_no_show', 'released_expert_invited_guest_only'])(
    'a released session (%s) is an info line — never the "declined" warn, never counted as settled',
    async (code) => {
      mockSettleSessionFromPresence.mockResolvedValue({ ok: false, code });

      const result = await runSessionMeterSweep(NOW);

      expect(result.presenceSettled).toBe(0);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session_9', code }),
        expect.stringContaining('released by the presence-settlement backstop')
      );
      expect(mockLoggerWarn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Presence settlement durability backstop declined'
      );
    }
  );

  it('any OTHER declined code still warns (the finder and the service disagree)', async () => {
    mockSettleSessionFromPresence.mockResolvedValue({ ok: false, code: 'meeting_not_terminal' });

    await runSessionMeterSweep(NOW);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session_9', code: 'meeting_not_terminal' }),
      'Presence settlement durability backstop declined'
    );
  });
});
