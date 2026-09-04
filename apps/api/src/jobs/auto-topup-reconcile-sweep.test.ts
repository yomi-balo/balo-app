import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CreditWallet } from '@balo/db';

const {
  mockFindStuckPendingTopups,
  mockReconcile,
  mockLog,
  mockMarkPendingTopupAlarmed,
  mockCountAlarmedPendingTopups,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  mockFindStuckPendingTopups: vi.fn(),
  mockReconcile: vi.fn(),
  /** Stable logger — the batch-fill warning and the aggregated alarm are asserted on it. */
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // BAL-521 §2 — the rotation stamp + the backlog count.
  mockMarkPendingTopupAlarmed: vi.fn(),
  mockCountAlarmedPendingTopups: vi.fn(),
  // BAL-521 (F8) — a holder the mocked `Worker` constructor below stashes its processor
  // function into, so `startAutoTopupReconcileSweepWorker`'s `job.log` summary line (previously
  // untested entirely) can be exercised for real rather than re-typed as a separate assertion.
  capturedWorkerProcessor: {
    fn: undefined as ((job: { log: (m: string) => void }) => Promise<void>) | undefined,
  },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('@balo/db', () => ({
  creditWalletsRepository: {
    findStuckPendingTopups: mockFindStuckPendingTopups,
    markPendingTopupAlarmed: mockMarkPendingTopupAlarmed,
    countAlarmedPendingTopups: mockCountAlarmedPendingTopups,
  },
}));
// The Worker/queue surface is never constructed by `runAutoTopupReconcileSweep`, but importing
// the module would otherwise open a real Redis connection. `startAutoTopupReconcileSweepWorker`
// DOES construct one — captured (not discarded) so its processor is reachable from a test (F8).
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_name: string, processor: (job: { log: (m: string) => void }) => Promise<void>) {
      capturedWorkerProcessor.fn = processor;
    }
  },
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: vi.fn() }) }));
vi.mock('../services/credit/auto-topup-reconcile.js', () => ({
  reconcileStuckAutoTopup: mockReconcile,
}));

import {
  runAutoTopupReconcileSweep,
  startAutoTopupReconcileSweepWorker,
} from './auto-topup-reconcile-sweep.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const RECONCILE_AFTER_MS = 5 * 60 * 1000;

function wallet(id: string): CreditWallet {
  return {
    id,
    companyId: `company_${id}`,
    mandateStatus: 'active',
    pendingTopupAt: new Date('2026-09-03T11:50:00.000Z'),
    pendingTopupTriggeringEntryId: `led_${id}`,
  } as unknown as CreditWallet;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindStuckPendingTopups.mockResolvedValue([]);
  mockReconcile.mockResolvedValue({ outcome: 'deferred', reason: 'still_in_flight' });
  // Default: everything the tick asked to stamp lands (no drift between read and stamp).
  mockMarkPendingTopupAlarmed.mockImplementation(
    async (pairs: ReadonlyArray<unknown>) => pairs.length
  );
  mockCountAlarmedPendingTopups.mockResolvedValue(0);
});

describe('runAutoTopupReconcileSweep', () => {
  it('asks for markers older than now − TOPUP_RECONCILE_AFTER_MS, bounded (ordering is the finder\'s own rotation contract — see credit-wallets.integration.test.ts\'s "OLDEST first (within the never-alarmed group)")', async () => {
    await runAutoTopupReconcileSweep(NOW);

    expect(mockFindStuckPendingTopups).toHaveBeenCalledWith(
      new Date(NOW.getTime() - RECONCILE_AFTER_MS),
      100
    );
  });

  it('reconciles every candidate and tallies the outcomes', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([
      wallet('w1'),
      wallet('w2'),
      wallet('w3'),
      wallet('w4'),
      wallet('w5'),
      wallet('w6'),
    ]);
    mockReconcile
      .mockResolvedValueOnce({ outcome: 'repaired', paymentIntentId: 'pi_1' })
      .mockResolvedValueOnce({ outcome: 'already_credited', paymentIntentId: 'pi_2' })
      .mockResolvedValueOnce({ outcome: 'failed_closed', paymentIntentId: 'pi_3' })
      .mockResolvedValueOnce({ outcome: 'skipped', reason: 'no_charge_found' })
      .mockResolvedValueOnce({ outcome: 'deferred', reason: 'pi_unreadable' })
      // A refunded crossing is CLEARED but NEVER credited — it must not read as `repaired`, which
      // is the health signal for "the webhook lane is dropping money".
      .mockResolvedValueOnce({ outcome: 'refunded', paymentIntentId: 'pi_6' });

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(mockReconcile).toHaveBeenCalledTimes(6);
    expect(result).toEqual({
      repaired: 1,
      alreadyCredited: 1,
      refunded: 1,
      failedClosed: 1,
      drained: 1,
      alarms: 0,
      partialRefundAlarms: 0,
      escalatedStillInFlight: 0,
      alarmedBacklogTotal: 0,
    });
  });

  it("passes the tick's clock down, so the reconcile ages every marker against one `now`", async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);

    await runAutoTopupReconcileSweep(NOW);

    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }), { now: NOW });
  });

  it('isolates a per-row failure: one throw never aborts the batch, and it is logged', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1'), wallet('w2'), wallet('w3')]);
    mockReconcile
      .mockRejectedValueOnce(new Error('stripe unavailable'))
      .mockResolvedValueOnce({ outcome: 'repaired', paymentIntentId: 'pi_2' })
      .mockResolvedValueOnce({ outcome: 'repaired', paymentIntentId: 'pi_3' });

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(mockReconcile).toHaveBeenCalledTimes(3);
    expect(result.repaired).toBe(2);
    expect(mockLog.error).toHaveBeenCalledWith(
      { walletId: 'w1', error: 'stripe unavailable' },
      'Auto-top-up reconcile failed'
    );
  });

  it('WARNS when the batch FILLS (no silent caps — the counts would understate the backlog)', async () => {
    const full = Array.from({ length: 100 }, (_unused, index) => wallet(`w${index}`));
    mockFindStuckPendingTopups.mockResolvedValue(full);

    await runAutoTopupReconcileSweep(NOW);

    // BAL-521 (F7) — `headWalletId`, not `oldestWalletId`: under the §2 rotation this is the HEAD
    // of the rotation order, not necessarily the oldest-by-`pending_topup_at` row.
    // BAL-521 (F8) — the EXACT message, not `stringContaining`: AMEND-6 rewrote this from the
    // pre-BAL-521 "were dropped from this tick" wording, and a loose assertion would not catch a
    // silent regression back to it.
    expect(mockLog.warn).toHaveBeenCalledWith(
      { limit: 100, headWalletId: 'w0' },
      'Auto-top-up reconcile batch FILLED — the stuck-reload backlog is at least this limit; some rows will reach a later tick (never dropped — each re-presents next tick with its evidence intact)'
    );
  });

  it('does not warn when the batch is not full', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    await runAutoTopupReconcileSweep(NOW);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('aggregates alarms into ONE log.error per tick, carrying every wallet in an array', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1'), wallet('w2')]);
    mockReconcile.mockResolvedValue({ outcome: 'alarm', reason: 'payment_intent_unresolvable' });

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(result.alarms).toBe(2);
    // ⚠ ONE record, not one per row — a stuck wallet would otherwise be 1,440 identical error
    // records a day while adding nothing a responder can act on.
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        // BAL-521 (F8) — `count` was dropped: it duplicated `reportedThisTick` on every alarm
        // record. Assert the field that survives, and that the redundant one is really gone.
        reportedThisTick: 2,
        wallets: [
          expect.objectContaining({ walletId: 'w1', triggeringEntryId: 'led_w1' }),
          expect.objectContaining({ walletId: 'w2', triggeringEntryId: 'led_w2' }),
        ],
      }),
      expect.stringContaining('could not be resolved')
    );
    // ⚠ THE COPY MUST NOT INVENT A DEADLINE. It used to tell the responder to act "before the
    // 15-minute TTL lets a later crossing re-arm the marker" — but a re-arm needs a LATER
    // CROSSING, and a dormant wallet never has one. For those rows there is no deadline and no
    // self-healing; they alarm forever.
    const [fields, message] = mockLog.error.mock.calls[0] ?? [];
    expect(message).toContain('nothing will self-heal');
    expect(message).not.toMatch(/before the 15-minute TTL/);
    // BAL-521 (F8) — the redundant `count` field is gone from the record, not merely unasserted.
    expect(Object.keys((fields as Record<string, unknown>) ?? {})).not.toContain('count');
  });

  it('batches a PARTIAL-REFUND alarm separately, with copy that does not call it unresolvable', async () => {
    // The two alarm reasons are different jobs for the responder: one is "find this PaymentIntent",
    // the other is "this charge was part-refunded and the remainder is still owed". One shared
    // record would tell half the responders the wrong thing.
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1'), wallet('w2')]);
    mockReconcile
      .mockResolvedValueOnce({ outcome: 'alarm', reason: 'payment_intent_unresolvable' })
      .mockResolvedValueOnce({ outcome: 'alarm', reason: 'partial_refund' });

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(result.alarms).toBe(2);
    expect(result.partialRefundAlarms).toBe(1);
    expect(mockLog.error).toHaveBeenCalledTimes(2);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'partial_refund',
        reportedThisTick: 1,
        wallets: [expect.objectContaining({ walletId: 'w2' })],
      }),
      expect.stringContaining('PARTIALLY refunded')
    );
  });

  it('emits no alarm record at all when nothing alarmed', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    mockReconcile.mockResolvedValue({ outcome: 'repaired', paymentIntentId: 'pi_1' });

    await runAutoTopupReconcileSweep(NOW);

    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('reports a completion summary', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    mockReconcile.mockResolvedValue({ outcome: 'repaired', paymentIntentId: 'pi_1' });

    const messages: string[] = [];
    await runAutoTopupReconcileSweep(NOW, (m) => messages.push(m));

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ repaired: 1, candidates: 1 }),
      'Auto-top-up reconcile sweep complete'
    );
    expect(messages).toEqual([]);
  });

  // ── BAL-521 §1 — the escalated still-in-flight batching ─────────────────────
  it('(D4/D5) batches escalated still-in-flight rows into ONE log.error per tick, carrying every wallet', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1'), wallet('w2'), wallet('w3')]);
    mockReconcile.mockResolvedValue({
      outcome: 'deferred',
      reason: 'still_in_flight_escalated',
      paymentIntentId: 'pi_stuck',
      piStatus: 'processing',
      stuckForMs: 999_999,
    });

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(result.escalatedStillInFlight).toBe(3);
    // ⚠ ONE record, not one per row — this is the exact batching the service USED TO do itself
    // (one `log.error` per row per tick) before BAL-521 §1 moved it here.
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 3,
        wallets: [
          expect.objectContaining({
            walletId: 'w1',
            paymentIntentId: 'pi_stuck',
            piStatus: 'processing',
            stuckForMs: 999_999,
          }),
          expect.objectContaining({ walletId: 'w2' }),
          expect.objectContaining({ walletId: 'w3' }),
        ],
      }),
      expect.stringContaining('still in flight far past the escalation window')
    );
  });

  // ⚠ (PIN) — a structural guard, not a regression test: it cannot fail on pre-fix source (there
  // is nothing to escalate, so `mockLog.error` was never going to be called either way). Kept as
  // documentation of the "empty ⇒ silent" contract, labelled per the file's PIN convention (F8).
  it('(PIN) emits no escalated record when nothing escalated', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    mockReconcile.mockResolvedValue({ outcome: 'deferred', reason: 'still_in_flight' });

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(result.escalatedStillInFlight).toBe(0);
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  // ── BAL-521 §2 — the rotation stamp ──────────────────────────────────────────
  it('(D1) stamps every alarmed row in ONE markPendingTopupAlarmed call per tick, never one per row', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1'), wallet('w2')]);
    mockReconcile.mockResolvedValue({ outcome: 'alarm', reason: 'payment_intent_unresolvable' });

    await runAutoTopupReconcileSweep(NOW);

    expect(mockMarkPendingTopupAlarmed).toHaveBeenCalledTimes(1);
    expect(mockMarkPendingTopupAlarmed).toHaveBeenCalledWith(
      [
        { walletId: 'w1', triggeringEntryId: 'led_w1' },
        { walletId: 'w2', triggeringEntryId: 'led_w2' },
      ],
      NOW
    );
  });

  // ⚠ (PIN) — same structural-guard caveat as above: nothing alarmed ⇒ `stampAlarmedRows` short-
  // circuits on `alarmed.length === 0` before it could call the repository either way (F8).
  it('(PIN) does not call markPendingTopupAlarmed when nothing alarmed this tick', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    mockReconcile.mockResolvedValue({ outcome: 'repaired', paymentIntentId: 'pi_1' });

    await runAutoTopupReconcileSweep(NOW);

    expect(mockMarkPendingTopupAlarmed).not.toHaveBeenCalled();
  });

  it('(D6) a mixed batch stamps ONLY the alarm row — the escalated still-in-flight row is NEVER stamped', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1'), wallet('w2')]);
    mockReconcile
      .mockResolvedValueOnce({ outcome: 'alarm', reason: 'payment_intent_unresolvable' })
      .mockResolvedValueOnce({
        outcome: 'deferred',
        reason: 'still_in_flight_escalated',
        paymentIntentId: 'pi_2',
        piStatus: 'processing',
        stuckForMs: 500,
      });

    await runAutoTopupReconcileSweep(NOW);

    expect(mockMarkPendingTopupAlarmed).toHaveBeenCalledTimes(1);
    expect(mockMarkPendingTopupAlarmed).toHaveBeenCalledWith(
      [{ walletId: 'w1', triggeringEntryId: 'led_w1' }],
      NOW
    );
  });

  it('(D2/DEC-5) every ALARM record carries alarmedBacklogTotal + reportedThisTick, and the copy states the rotating slice', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    mockReconcile.mockResolvedValue({ outcome: 'alarm', reason: 'payment_intent_unresolvable' });
    mockCountAlarmedPendingTopups.mockResolvedValue(137);

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(result.alarmedBacklogTotal).toBe(137);
    expect(mockCountAlarmedPendingTopups).toHaveBeenCalledWith(
      new Date(NOW.getTime() - RECONCILE_AFTER_MS)
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ alarmedBacklogTotal: 137, reportedThisTick: 1 }),
      expect.stringContaining('rotate least-recently-alarmed first')
    );
  });

  it('reports the backlog total EVEN when nothing alarmed this tick (a filled batch can push every alarmed row out)', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    mockReconcile.mockResolvedValue({ outcome: 'repaired', paymentIntentId: 'pi_1' });
    mockCountAlarmedPendingTopups.mockResolvedValue(42);

    const result = await runAutoTopupReconcileSweep(NOW);

    expect(result.alarmedBacklogTotal).toBe(42);
  });

  it('drops (and warns on) an alarmed wallet with no triggeringEntryId rather than stamping it blind (defensive — should be unreachable)', async () => {
    const noEntryId = { ...wallet('w1'), pendingTopupTriggeringEntryId: null } as CreditWallet;
    mockFindStuckPendingTopups.mockResolvedValue([noEntryId, wallet('w2')]);
    mockReconcile.mockResolvedValue({ outcome: 'alarm', reason: 'payment_intent_unresolvable' });

    await runAutoTopupReconcileSweep(NOW);

    expect(mockLog.warn).toHaveBeenCalledWith(
      { walletId: 'w1' },
      expect.stringContaining('has no pendingTopupTriggeringEntryId')
    );
    expect(mockMarkPendingTopupAlarmed).toHaveBeenCalledWith(
      [{ walletId: 'w2', triggeringEntryId: 'led_w2' }],
      NOW
    );
  });

  it('WARNS when stamped < alarmed.length (a marker moved on between the read and the stamp)', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1'), wallet('w2')]);
    mockReconcile.mockResolvedValue({ outcome: 'alarm', reason: 'payment_intent_unresolvable' });
    mockMarkPendingTopupAlarmed.mockResolvedValue(1);

    await runAutoTopupReconcileSweep(NOW);

    expect(mockLog.warn).toHaveBeenCalledWith(
      { alarmed: 2, stamped: 1 },
      expect.stringContaining('moved on between the read and the stamp')
    );
  });
});

// BAL-521 (F8) — the worker's own `job.log` completion summary was previously untested (not even
// loosely): a change to `startAutoTopupReconcileSweepWorker`'s template literal could regress
// silently. Exercises the REAL processor (captured off the mocked `Worker` constructor above),
// not a re-typed copy of its shape.
describe('startAutoTopupReconcileSweepWorker (the job.log completion summary)', () => {
  it('logs the exact completion summary via job.log', async () => {
    mockFindStuckPendingTopups.mockResolvedValue([wallet('w1')]);
    mockReconcile.mockResolvedValue({ outcome: 'repaired', paymentIntentId: 'pi_1' });

    startAutoTopupReconcileSweepWorker();
    const processor = capturedWorkerProcessor.fn;
    if (processor === undefined) {
      throw new Error('Worker processor was never captured — the bullmq mock did not fire');
    }

    const jobLog = vi.fn();
    await processor({ log: jobLog });

    expect(jobLog).toHaveBeenCalledWith(
      'auto-top-up reconcile: 1 repaired, 0 already-credited, 0 refunded, 0 failed-closed, 0 drained, 0 alarms (0 partial-refund, 0 alarmed in total), 0 escalated still-in-flight'
    );
  });
});
