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
    mockMarkProcessed: vi.fn(async (id: string) => {
      const row = store.get(id);
      if (row) row.processedAt = new Date();
    }),
    mockApplyLedgerEntry: vi.fn(async () => ({ deduped: false })),
    mockAuditRecord: vi.fn(async () => ({})),
    mockApplyMandate: vi.fn(async () => ({})),
    mockApplyMandateStatus: vi.fn(async () => ({})),
  };
});

vi.mock('stripe', async () => (await import('../../test/mocks/stripe.js')).stripeMockModule());
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
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
  deriveIdempotencyKey: (input: { reason: string }) => `${input.reason}:key`,
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
    mockInsertReceived.mockClear();
    mockMarkProcessed.mockClear();
    mockApplyLedgerEntry.mockClear();
    mockAuditRecord.mockClear();
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

  it('is idempotent: a replayed event id applies the effect exactly once', async () => {
    const first = await inject(app, succeededEvent);
    const second = await inject(app, succeededEvent);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(mockApplyLedgerEntry).toHaveBeenCalledTimes(1);
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
});
