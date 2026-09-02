import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';

const {
  mockFindMeterable,
  mockFindWrappedIdle,
  mockFindStalePending,
  mockFindStuckSettling,
  mockFindFinalizedMissingPayout,
  mockFindPresenceUnsettled,
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
} = vi.hoisted(() => ({
  mockFindMeterable: vi.fn(),
  mockFindWrappedIdle: vi.fn(),
  mockFindStalePending: vi.fn(),
  mockFindStuckSettling: vi.fn(),
  mockFindFinalizedMissingPayout: vi.fn(),
  mockFindPresenceUnsettled: vi.fn(),
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
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
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
    findPresenceUnsettled: mockFindPresenceUnsettled,
    findPendingForCancelledMeetings: mockFindPendingForCancelledMeetings,
    findSettledMissingLedgerCredit: mockFindSettledMissingLedgerCredit,
    cancel: mockCancel,
  },
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn() }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn() }));
vi.mock('../services/credit-session/index.js', () => ({
  driveSession: mockDriveSession,
  endSessionAsSystem: mockEndSession,
  reconcileStuckSettlement: mockReconcile,
  finalizeBilling: mockFinalizeBilling,
  settleSessionFromPresence: mockSettleSessionFromPresence,
}));

import { runSessionMeterSweep } from './credit-session-meter-sweep.js';

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
    mockFindPresenceUnsettled.mockResolvedValue([]);
    mockFindPendingForCancelledMeetings.mockResolvedValue([]);
    mockFindSettledMissingLedgerCredit.mockResolvedValue([]);
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
      mockFindPresenceUnsettled.mockResolvedValue([
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
      mockFindPresenceUnsettled.mockResolvedValue([
        activeSession({ id: 's1', durationSource: 'presence' }),
      ]);
      mockSettleSessionFromPresence.mockResolvedValue({ ok: false, code: 'already_settled' });
      const result = await runSessionMeterSweep(NOW);
      expect(result.presenceSettled).toBe(0);
    });

    it('isolates a per-row settlement failure (batch continues, sweep does not abort)', async () => {
      mockFindPresenceUnsettled.mockResolvedValue([
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
});
