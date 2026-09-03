import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CreditWallet } from '@balo/db';

const { mockFindStuckPendingTopups, mockReconcile, mockLog } = vi.hoisted(() => ({
  mockFindStuckPendingTopups: vi.fn(),
  mockReconcile: vi.fn(),
  /** Stable logger — the batch-fill warning and the aggregated alarm are asserted on it. */
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findStuckPendingTopups: mockFindStuckPendingTopups },
}));
// The Worker/queue surface is never constructed by `runAutoTopupReconcileSweep`, but importing
// the module would otherwise open a real Redis connection.
vi.mock('bullmq', () => ({ Worker: class {} }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: vi.fn() }) }));
vi.mock('../services/credit/auto-topup-reconcile.js', () => ({
  reconcileStuckAutoTopup: mockReconcile,
}));

import { runAutoTopupReconcileSweep } from './auto-topup-reconcile-sweep.js';

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
});

describe('runAutoTopupReconcileSweep', () => {
  it('asks for markers older than now − TOPUP_RECONCILE_AFTER_MS, oldest first, bounded', async () => {
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

    expect(mockLog.warn).toHaveBeenCalledWith(
      { limit: 100, oldestWalletId: 'w0' },
      expect.stringContaining('batch FILLED')
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
        count: 2,
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
    const [, message] = mockLog.error.mock.calls[0] ?? [];
    expect(message).toContain('nothing will self-heal');
    expect(message).not.toMatch(/before the 15-minute TTL/);
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
        count: 1,
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
});
