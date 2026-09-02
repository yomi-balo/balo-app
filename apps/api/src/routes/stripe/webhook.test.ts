import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

interface StoredEvent {
  eventId: string;
  type: string;
  processedAt: Date | null;
}

const {
  eventStore,
  mockFindByEventId,
  mockInsertReceived,
  mockMarkProcessed,
  mockApplyLedgerEntry,
  mockAuditRecord,
  mockApplyMandate,
  mockApplyMandateStatus,
  mockRedeem,
  mockPublish,
  mockCaptureException,
} = vi.hoisted(() => {
  const store = new Map<string, StoredEvent>();
  return {
    eventStore: store,
    mockFindByEventId: vi.fn(async (id: string) => store.get(id)),
    mockInsertReceived: vi.fn(async (input: { eventId: string; type: string }) => {
      if (store.has(input.eventId)) return undefined;
      const row: StoredEvent = { eventId: input.eventId, type: input.type, processedAt: null };
      store.set(input.eventId, row);
      return row;
    }),
    // BAL-515 — `markProcessed` now reports whether a row was ACTUALLY stamped, and the route
    // throws on `false`. The stub mirrors the repository: no row ⇒ no stamp ⇒ `false`.
    mockMarkProcessed: vi.fn(async (id: string) => {
      const row = store.get(id);
      if (!row) return false;
      row.processedAt = new Date();
      return true;
    }),
    mockApplyLedgerEntry: vi.fn(async () => ({
      deduped: false,
      entry: { id: 'ledger_1' },
      wallet: { companyId: 'company_1', balanceMinor: 10000, expiresAt: new Date('2027-01-01') },
    })),
    mockAuditRecord: vi.fn(async () => ({})),
    mockApplyMandate: vi.fn(async () => ({})),
    mockApplyMandateStatus: vi.fn(async () => ({})),
    mockRedeem: vi.fn(),
    mockPublish: vi.fn(async () => undefined),
    // The app error handler captures to Sentry before answering 500 — the only place the
    // commit-proof STAGE is observable, and what distinguishes the two guards from each other.
    mockCaptureException: vi.fn(),
  };
});

vi.mock('stripe', async () => (await import('../../test/mocks/stripe.js')).stripeMockModule());
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
vi.mock('@balo/db', () => ({
  db: { transaction: async (cb: (tx: unknown) => unknown) => cb({ __tx: true }) },
  stripeWebhookEventsRepository: {
    findByEventId: mockFindByEventId,
    insertReceived: mockInsertReceived,
    markProcessed: mockMarkProcessed,
  },
  applyLedgerEntry: mockApplyLedgerEntry,
  auditEventsRepository: { record: mockAuditRecord },
  creditWalletsRepository: {
    applyMandate: mockApplyMandate,
    applyMandateStatus: mockApplyMandateStatus,
  },
  promoRedemptionsRepository: { redeem: mockRedeem },
  deriveIdempotencyKey: (input: { reason: string }) => `${input.reason}:key`,
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

import { buildApp } from '../../app.js';
import { mockStripe, resetStripeMock } from '../../test/mocks/stripe.js';

function inject(app: FastifyInstance, body: unknown, signature = 'valid_sig') {
  return app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload: JSON.stringify(body),
  });
}

const succeededEvent = {
  id: 'evt_pi_succeeded',
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: 'pi_1',
      metadata: { walletId: 'wallet_1', reason: 'manual_purchase', memberId: 'member_1' },
    },
  },
};

describe('POST /webhooks/stripe', () => {
  let app: FastifyInstance;
  const originalSecret = process.env.STRIPE_SECRET_KEY;
  const originalWebhook = process.env.STRIPE_WEBHOOK_SECRET;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    process.env.STRIPE_SECRET_KEY = originalSecret;
    process.env.STRIPE_WEBHOOK_SECRET = originalWebhook;
  });

  beforeEach(() => {
    eventStore.clear();
    resetStripeMock();
    mockFindByEventId.mockClear();
    mockMarkProcessed.mockReset();
    mockMarkProcessed.mockImplementation(async (id: string) => {
      const row = eventStore.get(id);
      if (!row) return false;
      row.processedAt = new Date();
      return true;
    });
    mockInsertReceived.mockClear();
    mockMarkProcessed.mockClear();
    mockApplyLedgerEntry.mockClear();
    mockAuditRecord.mockClear();
    mockRedeem.mockClear();
    mockPublish.mockClear();
    mockCaptureException.mockClear();
    // Default settlement retrieval for payment_intent.succeeded.
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_1', latest_charge: 'ch_1' });
    mockStripe.charges.retrieve.mockResolvedValue({
      id: 'ch_1',
      currency: 'aud',
      amount: 10000,
      balance_transaction: { id: 'txn_1', amount: 10000, currency: 'aud', exchange_rate: null },
    });
  });

  it('returns 400 on an invalid signature (no retry) without applying any effect', async () => {
    const res = await inject(app, succeededEvent, 'invalid');
    expect(res.statusCode).toBe(400);
    expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });

  it('returns 200 and applies the credit effect for payment_intent.succeeded', async () => {
    const res = await inject(app, succeededEvent);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(mockApplyLedgerEntry).toHaveBeenCalledTimes(1);
    expect(mockApplyLedgerEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        walletId: 'wallet_1',
        reason: 'manual_purchase',
        entryType: 'purchase',
        amountMinor: 10000,
      })
    );
    expect(mockMarkProcessed).toHaveBeenCalledWith('evt_pi_succeeded', expect.anything());
  });

  it('publishes the credit.topup.completed receipt POST-COMMIT for a manual purchase', async () => {
    const res = await inject(app, succeededEvent);
    expect(res.statusCode).toBe(200);
    expect(mockPublish).toHaveBeenCalledWith(
      'credit.topup.completed',
      expect.objectContaining({
        correlationId: 'manual_purchase:key',
        userId: 'member_1',
        companyId: 'company_1',
        creditedMinor: 10000,
        chargedCurrency: 'aud',
        chargedAmountMinor: 10000,
        promoGrantedMinor: 0,
        balanceAfterMinor: 10000,
      })
    );
  });

  it('is idempotent: a replayed event id applies the effect exactly once', async () => {
    const first = await inject(app, succeededEvent);
    const second = await inject(app, succeededEvent);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(mockApplyLedgerEntry).toHaveBeenCalledTimes(1);
    // The replay short-circuits before the effect → only ONE receipt is ever published.
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('acks 200 for an unknown event type with no ledger effect (marker still recorded)', async () => {
    const res = await inject(app, {
      id: 'evt_unknown',
      type: 'invoice.paid',
      data: { object: { id: 'in_1' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    expect(mockInsertReceived).toHaveBeenCalledTimes(1);
    expect(mockMarkProcessed).toHaveBeenCalledWith('evt_unknown', expect.anything());
  });

  it('records a dispute audit row for charge.dispute.created and acks 200', async () => {
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ metadata: { walletId: 'wallet_1' } });
    const res = await inject(app, {
      id: 'evt_dispute',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_1',
          charge: 'ch_1',
          payment_intent: 'pi_1',
          amount: 7600,
          currency: 'aud',
          reason: 'fraudulent',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'credit_wallet.dispute_opened', entityId: 'wallet_1' }),
      expect.anything()
    );
  });

  // ── BAL-515: the commit proof ───────────────────────────────────────────────

  it('returns 500 (never 200) when the transaction resolved with NO committed marker', async () => {
    // ⚠ THE PHANTOM COMMIT, REPRODUCED. `markProcessed` reports success (as the real UPDATE did —
    // the statement worked; the COMMIT lied), but the marker is NOT visible on a fresh read
    // afterwards. Before BAL-515 this answered 200 and Stripe never redelivered, which is exactly
    // how a real A$300 top-up was charged and never credited.
    mockMarkProcessed.mockImplementationOnce(async (id: string) => {
      eventStore.delete(id);
      return true;
    });

    const res = await inject(app, succeededEvent);

    expect(res.statusCode).toBe(500);
    expect(mockMarkProcessed).toHaveBeenCalledTimes(1);
    // ⚠ THE STAGE IS THE ASSERTION. `markProcessed` reported success, so only the POST-COMMIT
    // read-back can catch this; naming the stage stops the in-transaction guard from standing in
    // for a read-back that has been deleted.
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'StripeWebhookCommitProofError',
        message: expect.stringContaining('post_commit_readback'),
      })
    );
    // ⚠ AND ITS POSITION IS THE OTHER HALF OF THE ASSERTION. The read-back must run BEFORE the
    // post-commit drain loop, so an UNCOMMITTED effect can never publish a notification or fire
    // analytics — neither can be undone by the 500 that follows. This event is a manual purchase,
    // so a drain that ran first would send the buyer a `credit.topup.completed` receipt for credit
    // that does not exist. Nothing else in this file pins the order: moving the read-back below
    // the loop leaves every other assertion green.
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns 500 when the marker row exists but was never STAMPED (existence is not proof)', async () => {
    // A concurrent delivery can legitimately have inserted the row; only `processed_at` proves
    // THIS transaction's work landed. Asserting mere row existence would ack the incident.
    mockMarkProcessed.mockImplementationOnce(async (id: string) => {
      const row = eventStore.get(id);
      if (row) row.processedAt = null;
      return true;
    });

    const res = await inject(app, succeededEvent);

    expect(res.statusCode).toBe(500);
  });

  it('returns 500 when markProcessed stamps ZERO rows (the in-transaction row-count check)', async () => {
    mockMarkProcessed.mockResolvedValueOnce(false);

    const res = await inject(app, succeededEvent);

    expect(res.statusCode).toBe(500);
    // ⚠ THE STAGE IS THE ASSERTION. Both guards would 500 on this input; only the in-transaction
    // row-count check throws BEFORE the commit, which is what keeps a half-applied effect from
    // ever being committed. Without naming the stage, deleting this guard still reads as green.
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'StripeWebhookCommitProofError',
        message: expect.stringContaining('mark_processed'),
      })
    );
  });

  it('still acks 200 on the concurrent-delivery short-circuit (the other delivery stamped it)', async () => {
    // The other delivery has already committed a PROCESSED marker; `insertReceived` returns
    // undefined and the transaction returns early WITHOUT calling markProcessed. The read-back
    // must be satisfied by the other delivery's `processedAt` — asserting on our own stamp here
    // would 500 a perfectly correct request.
    eventStore.set('evt_concurrent', {
      eventId: 'evt_concurrent',
      type: 'invoice.paid',
      processedAt: new Date(),
    });
    // Force the slow path: report "not yet processed" to the pre-transaction short-circuit only.
    mockFindByEventId.mockImplementationOnce(async () => undefined);

    const res = await inject(app, {
      id: 'evt_concurrent',
      type: 'invoice.paid',
      data: { object: { id: 'in_1' } },
    });

    expect(res.statusCode).toBe(200);
    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it('reads the commit proof back on the BASE db, not the transaction handle', async () => {
    // ⚠ A `.returning()` check INSIDE the transaction would NOT have caught the incident — the
    // UPDATE succeeded; the COMMIT lied. The proof read must land on a different pooled
    // connection, which is what passing no `exec` argument achieves.
    const res = await inject(app, succeededEvent);

    expect(res.statusCode).toBe(200);
    const calls = mockFindByEventId.mock.calls;
    const orders = mockFindByEventId.mock.invocationCallOrder;
    const markOrder = mockMarkProcessed.mock.invocationCallOrder[0] ?? Infinity;
    // The LAST read must come AFTER the stamp (post-commit) and carry NO executor argument, so it
    // lands on the base `db` — a different pooled connection from the transaction being proved.
    const lastIndex = calls.length - 1;
    expect(orders[lastIndex] ?? -Infinity).toBeGreaterThan(markOrder);
    expect(calls[lastIndex]).toEqual(['evt_pi_succeeded']);
  });

  it('writes NO dedupe marker when effect resolution throws, so Stripe can retry and credit', async () => {
    // This is the invariant the whole failure mode rests on. A real A$1,000 top-up 500'd here
    // because the charge had no balance_transaction yet; the wallet was credited only when the
    // event was redelivered. That recovery is possible ONLY because the marker is written
    // after resolution (webhook.ts:49 resolves, :57-58 inserts). If anyone "optimises" the
    // insert to before the resolve, the retry is deduped away and the customer's money is
    // charged and never credited — permanently, with no trace.
    mockStripe.paymentIntents.retrieve.mockRejectedValue(new Error('stripe unavailable'));

    const res = await inject(app, {
      id: 'evt_resolve_throws',
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_boom', metadata: { walletId: 'wallet_1', reason: 'manual_purchase' } },
      },
    });

    expect(res.statusCode).toBe(500); // 500, not 400 — Stripe only retries server errors.
    expect(mockInsertReceived).not.toHaveBeenCalled();
    expect(mockMarkProcessed).not.toHaveBeenCalled();
    expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
  });
});
