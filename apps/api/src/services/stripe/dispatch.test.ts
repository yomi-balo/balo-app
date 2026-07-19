import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SettlementFields } from './types.js';

interface DeriveInput {
  reason: string;
  paymentIntentId?: string;
  walletId?: string;
  triggeringEntryId?: string;
  sessionId?: string;
}

const {
  mockApplyLedgerEntry,
  mockAuditRecord,
  mockApplyMandate,
  mockApplyMandateStatus,
  mockRedeem,
  mockDeriveIdempotencyKey,
  mockRetrieveSettlement,
  mockPaymentIntentsRetrieve,
  mockChargesRetrieve,
  mockSessionFindById,
  mockMarkSettlementResult,
  mockReceivableOpen,
  mockReceivableClear,
  mockPublishSessionSettled,
  mockPublishSettlementFailure,
  mockNotificationPublish,
} = vi.hoisted(() => ({
  // Default: a fresh credit onto a wallet the receipt can read (companyId/balance/expiry).
  mockApplyLedgerEntry: vi.fn(async () => ({
    deduped: false,
    entry: { id: 'ledger_1' },
    wallet: { companyId: 'company_1', balanceMinor: 17600, expiresAt: new Date('2027-01-01') },
  })),
  mockAuditRecord: vi.fn(),
  mockApplyMandate: vi.fn(),
  mockApplyMandateStatus: vi.fn(),
  mockRedeem: vi.fn(),
  mockDeriveIdempotencyKey: vi.fn((input: DeriveInput) => {
    switch (input.reason) {
      case 'manual_purchase':
        return `manual_purchase:${input.paymentIntentId}`;
      case 'auto_topup':
        return `auto_topup:${input.walletId}:${input.triggeringEntryId}`;
      case 'overdraft_settlement':
        return `overdraft_settlement:${input.sessionId}`;
      default:
        return String(input.reason);
    }
  }),
  mockRetrieveSettlement: vi.fn(),
  mockPaymentIntentsRetrieve: vi.fn(),
  mockChargesRetrieve: vi.fn(),
  mockSessionFindById: vi.fn(),
  mockMarkSettlementResult: vi.fn(),
  mockReceivableOpen: vi.fn(),
  mockReceivableClear: vi.fn(),
  mockPublishSessionSettled: vi.fn(),
  mockPublishSettlementFailure: vi.fn(),
  mockNotificationPublish: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  applyLedgerEntry: mockApplyLedgerEntry,
  auditEventsRepository: { record: mockAuditRecord },
  creditWalletsRepository: {
    applyMandate: mockApplyMandate,
    applyMandateStatus: mockApplyMandateStatus,
  },
  creditSessionsRepository: {
    findById: mockSessionFindById,
    markSettlementResult: mockMarkSettlementResult,
  },
  creditReceivablesRepository: {
    open: mockReceivableOpen,
    clear: mockReceivableClear,
  },
  promoRedemptionsRepository: { redeem: mockRedeem },
  deriveIdempotencyKey: mockDeriveIdempotencyKey,
  db: {},
}));
vi.mock('../credit-session/notify.js', () => ({
  publishSessionSettled: mockPublishSessionSettled,
  publishSettlementFailure: mockPublishSettlementFailure,
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockNotificationPublish },
}));
vi.mock('../../lib/stripe.js', () => ({
  getStripeClient: () => ({
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve },
    charges: { retrieve: mockChargesRetrieve },
  }),
}));
vi.mock('./charges.js', () => ({ retrieveSettlement: mockRetrieveSettlement }));

import { applyStripeEffect, resolveStripeEffect } from './dispatch.js';
import { StripeSettlementError } from './errors.js';

/** Build a minimal Stripe.Event shell for the dispatcher's `switch (event.type)`. */
function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: `evt_${type}`, type, data: { object } } as unknown as Stripe.Event;
}

const SETTLEMENT: SettlementFields = {
  creditAmountMinor: 7600,
  chargedCurrency: 'usd',
  chargedAmountMinor: 5000,
  fxRate: '1.52',
  stripePaymentIntentId: 'pi_1',
  stripeChargeId: 'ch_1',
  stripeBalanceTransactionId: 'txn_1',
};

/** A stub transaction handle — the mocked repos ignore it. */
const tx = {} as Parameters<typeof applyStripeEffect>[0];

describe('resolveStripeEffect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps payment_intent.succeeded → credit effect (with settlement)', async () => {
    mockRetrieveSettlement.mockResolvedValue(SETTLEMENT);
    const effect = await resolveStripeEffect(
      event('payment_intent.succeeded', {
        id: 'pi_1',
        metadata: { walletId: 'wallet_1', reason: 'manual_purchase', memberId: 'member_1' },
      })
    );
    expect(effect).toEqual({
      kind: 'credit',
      reason: 'manual_purchase',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: null,
      triggeringEntryId: null,
      promoCode: null,
      settlement: SETTLEMENT,
    });
    expect(mockRetrieveSettlement).toHaveBeenCalledWith('pi_1');
  });

  it('threads a manual_purchase promoCode from PI metadata into the credit effect', async () => {
    mockRetrieveSettlement.mockResolvedValue(SETTLEMENT);
    const effect = await resolveStripeEffect(
      event('payment_intent.succeeded', {
        id: 'pi_1',
        metadata: {
          walletId: 'wallet_1',
          reason: 'manual_purchase',
          memberId: 'member_1',
          promoCode: 'WELCOME50',
        },
      })
    );
    expect(effect).toMatchObject({ kind: 'credit', promoCode: 'WELCOME50' });
  });

  it('never threads a promoCode for a non-manual credit reason (auto_topup)', async () => {
    mockRetrieveSettlement.mockResolvedValue(SETTLEMENT);
    const effect = await resolveStripeEffect(
      event('payment_intent.succeeded', {
        id: 'pi_1',
        metadata: {
          walletId: 'wallet_1',
          reason: 'auto_topup',
          triggeringEntryId: 'entry_1',
          promoCode: 'WELCOME50',
        },
      })
    );
    expect(effect).toMatchObject({ kind: 'credit', reason: 'auto_topup', promoCode: null });
  });

  it('returns null for payment_intent.succeeded with missing metadata', async () => {
    const effect = await resolveStripeEffect(
      event('payment_intent.succeeded', { id: 'pi_x', metadata: {} })
    );
    expect(effect).toBeNull();
    expect(mockRetrieveSettlement).not.toHaveBeenCalled();
  });

  it('maps payment_intent.payment_failed → charge_failed with Radar-aware outcome', async () => {
    mockChargesRetrieve.mockResolvedValue({
      outcome: { type: 'blocked', reason: 'highest_risk_level' },
    });
    const effect = await resolveStripeEffect(
      event('payment_intent.payment_failed', {
        id: 'pi_2',
        latest_charge: 'ch_2',
        metadata: { walletId: 'wallet_1' },
        last_payment_error: { code: 'card_declined' },
      })
    );
    expect(effect).toEqual({
      kind: 'charge_failed',
      walletId: 'wallet_1',
      paymentIntentId: 'pi_2',
      code: 'card_declined',
      outcome: { type: 'blocked', reason: 'highest_risk_level' },
      reason: null,
      sessionId: null,
    });
  });

  it('maps payment_intent.payment_failed → charge_failed carrying overdraft reason + sessionId', async () => {
    mockChargesRetrieve.mockResolvedValue({ outcome: { type: 'issuer_declined' } });
    const effect = await resolveStripeEffect(
      event('payment_intent.payment_failed', {
        id: 'pi_ov',
        latest_charge: 'ch_ov',
        metadata: { walletId: 'wallet_1', reason: 'overdraft_settlement', sessionId: 'session_9' },
        last_payment_error: { code: 'card_declined' },
      })
    );
    expect(effect).toMatchObject({
      kind: 'charge_failed',
      reason: 'overdraft_settlement',
      sessionId: 'session_9',
    });
  });

  it('maps setup_intent.succeeded → mandate_active', async () => {
    const effect = await resolveStripeEffect(
      event('setup_intent.succeeded', {
        id: 'seti_1',
        customer: 'cus_1',
        payment_method: 'pm_1',
        metadata: { walletId: 'wallet_1' },
      })
    );
    expect(effect).toEqual({
      kind: 'mandate_active',
      walletId: 'wallet_1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      mandateRef: 'seti_1',
    });
  });

  it('maps setup_intent.setup_failed → mandate_failed', async () => {
    const effect = await resolveStripeEffect(
      event('setup_intent.setup_failed', { id: 'seti_2', metadata: { walletId: 'wallet_1' } })
    );
    expect(effect).toEqual({ kind: 'mandate_failed', walletId: 'wallet_1' });
  });

  it('maps charge.dispute.created → dispute (walletId recovered from the PaymentIntent)', async () => {
    mockPaymentIntentsRetrieve.mockResolvedValue({ metadata: { walletId: 'wallet_1' } });
    const effect = await resolveStripeEffect(
      event('charge.dispute.created', {
        id: 'dp_1',
        charge: 'ch_1',
        payment_intent: 'pi_1',
        amount: 7600,
        currency: 'aud',
        reason: 'fraudulent',
      })
    );
    expect(effect).toEqual({
      kind: 'dispute',
      walletId: 'wallet_1',
      disputeId: 'dp_1',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      amountMinor: 7600,
      currency: 'aud',
      reason: 'fraudulent',
    });
    expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith('pi_1');
  });

  it('returns null for an unhandled event type', async () => {
    const effect = await resolveStripeEffect(event('invoice.paid', { id: 'in_1' }));
    expect(effect).toBeNull();
  });

  it('payment_intent.payment_failed with no latest_charge uses last_payment_error as outcome', async () => {
    const effect = await resolveStripeEffect(
      event('payment_intent.payment_failed', {
        id: 'pi_3',
        latest_charge: null,
        metadata: { walletId: 'wallet_1' },
        last_payment_error: { code: 'card_declined', decline_code: 'generic_decline' },
      })
    );
    expect(effect).toEqual({
      kind: 'charge_failed',
      walletId: 'wallet_1',
      paymentIntentId: 'pi_3',
      code: 'card_declined',
      outcome: { code: 'card_declined', decline_code: 'generic_decline' },
      reason: null,
      sessionId: null,
    });
    expect(mockChargesRetrieve).not.toHaveBeenCalled();
  });

  it('payment_intent.payment_failed falls back to last_payment_error when the charge retrieve fails', async () => {
    mockChargesRetrieve.mockRejectedValue(new Error('stripe unavailable'));
    const effect = await resolveStripeEffect(
      event('payment_intent.payment_failed', {
        id: 'pi_4',
        latest_charge: 'ch_4',
        metadata: {}, // no walletId → null
        last_payment_error: { code: 'processing_error' },
      })
    );
    expect(effect).toEqual({
      kind: 'charge_failed',
      walletId: null,
      paymentIntentId: 'pi_4',
      code: 'processing_error',
      outcome: { code: 'processing_error' },
      reason: null,
      sessionId: null,
    });
  });

  it('returns null for setup_intent.succeeded missing customer / payment_method / walletId', async () => {
    const effect = await resolveStripeEffect(
      event('setup_intent.succeeded', {
        id: 'seti_x',
        customer: null,
        payment_method: null,
        metadata: {},
      })
    );
    expect(effect).toBeNull();
  });

  it('returns null for setup_intent.setup_failed missing walletId', async () => {
    const effect = await resolveStripeEffect(
      event('setup_intent.setup_failed', { id: 'seti_y', metadata: {} })
    );
    expect(effect).toBeNull();
  });

  it('returns null for charge.dispute.created with no payment_intent', async () => {
    const effect = await resolveStripeEffect(
      event('charge.dispute.created', {
        id: 'dp_2',
        charge: 'ch_2',
        payment_intent: null,
        amount: 100,
        currency: 'aud',
        reason: 'fraudulent',
      })
    );
    expect(effect).toBeNull();
    expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
  });

  it('returns null for charge.dispute.created when the PaymentIntent has no walletId metadata', async () => {
    mockPaymentIntentsRetrieve.mockResolvedValue({ metadata: {} });
    const effect = await resolveStripeEffect(
      event('charge.dispute.created', {
        id: 'dp_3',
        charge: 'ch_3',
        payment_intent: 'pi_5',
        amount: 100,
        currency: 'aud',
        reason: 'fraudulent',
      })
    );
    expect(effect).toBeNull();
  });

  it('propagates a settlement error from retrieveSettlement (e.g. the non-AUD guard)', async () => {
    mockRetrieveSettlement.mockRejectedValue(new StripeSettlementError('not AUD'));
    await expect(
      resolveStripeEffect(
        event('payment_intent.succeeded', {
          id: 'pi_6',
          metadata: { walletId: 'wallet_1', reason: 'manual_purchase' },
        })
      )
    ).rejects.toBeInstanceOf(StripeSettlementError);
  });
});

describe('applyStripeEffect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ledger writes report a fresh (non-deduped) apply onto a wallet the receipt can read;
    // receivable opens are fresh.
    mockApplyLedgerEntry.mockResolvedValue({
      deduped: false,
      entry: { id: 'ledger_1' },
      wallet: { companyId: 'company_1', balanceMinor: 17600, expiresAt: new Date('2027-01-01') },
    });
    mockReceivableOpen.mockResolvedValue({ receivable: { id: 'rcv_1' }, created: true });
  });

  it('applies a manual_purchase credit via applyLedgerEntry with the PI-keyed idempotency key', async () => {
    const postCommit = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'manual_purchase',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: null,
      triggeringEntryId: null,
      promoCode: null,
      settlement: SETTLEMENT,
    });
    expect(mockApplyLedgerEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        walletId: 'wallet_1',
        entryType: 'purchase',
        reason: 'manual_purchase',
        amountMinor: 7600,
        idempotencyKey: 'manual_purchase:pi_1',
        memberId: 'member_1',
        chargedCurrency: 'usd',
        chargedAmountMinor: 5000,
        fxRate: '1.52',
        stripePaymentIntentId: 'pi_1',
        stripeChargeId: 'ch_1',
        stripeBalanceTransactionId: 'txn_1',
      })
    );
    // Fresh manual_purchase → one DEFERRED post-commit receipt publish (no promo → 0 bonus).
    expect(mockRedeem).not.toHaveBeenCalled();
    expect(mockNotificationPublish).not.toHaveBeenCalled();
    expect(postCommit).toHaveLength(1);
    await postCommit[0]?.();
    expect(mockNotificationPublish).toHaveBeenCalledWith(
      'credit.topup.completed',
      expect.objectContaining({
        correlationId: 'manual_purchase:pi_1',
        userId: 'member_1',
        companyId: 'company_1',
        creditedMinor: 7600,
        promoGrantedMinor: 0,
        balanceAfterMinor: 17600,
      })
    );
  });

  it('grants a promo best-effort on a manual_purchase and reflects it in the receipt', async () => {
    mockRedeem.mockResolvedValue({ outcome: 'redeemed', grantMinor: 5000, ledgerEntryId: 'le_2' });
    const postCommit = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'manual_purchase',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: null,
      triggeringEntryId: null,
      promoCode: 'WELCOME50',
      settlement: SETTLEMENT,
    });
    expect(mockRedeem).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        code: 'WELCOME50',
        companyId: 'company_1',
        walletId: 'wallet_1',
        redeemedByUserId: 'member_1',
      })
    );
    expect(postCommit).toHaveLength(1);
    await postCommit[0]?.();
    expect(mockNotificationPublish).toHaveBeenCalledWith(
      'credit.topup.completed',
      expect.objectContaining({ promoGrantedMinor: 5000, balanceAfterMinor: 22600 })
    );
  });

  it('skips a promo that failed re-validation at settlement (base purchase still credits)', async () => {
    mockRedeem.mockRejectedValue(new Error('PromoExhaustedError'));
    const postCommit = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'manual_purchase',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: null,
      triggeringEntryId: null,
      promoCode: 'WELCOME50',
      settlement: SETTLEMENT,
    });
    // Base purchase credited; promo skipped → 0 bonus, receipt still published post-commit.
    expect(mockApplyLedgerEntry).toHaveBeenCalledTimes(1);
    expect(postCommit).toHaveLength(1);
    await postCommit[0]?.();
    expect(mockNotificationPublish).toHaveBeenCalledWith(
      'credit.topup.completed',
      expect.objectContaining({ promoGrantedMinor: 0, balanceAfterMinor: 17600 })
    );
  });

  it('does not re-grant or surface a receipt on a deduped (replayed) manual_purchase credit', async () => {
    mockApplyLedgerEntry.mockResolvedValueOnce({
      deduped: true,
      entry: { id: 'ledger_1' },
      wallet: { companyId: 'company_1', balanceMinor: 17600, expiresAt: new Date('2027-01-01') },
    });
    const postCommit = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'manual_purchase',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: null,
      triggeringEntryId: null,
      promoCode: 'WELCOME50',
      settlement: SETTLEMENT,
    });
    expect(postCommit).toEqual([]);
    expect(mockRedeem).not.toHaveBeenCalled();
    expect(mockNotificationPublish).not.toHaveBeenCalled();
  });

  it('applies an auto_topup credit with the wallet+entry-keyed idempotency key', async () => {
    const postCommit = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'auto_topup',
      walletId: 'wallet_1',
      memberId: null,
      sessionId: null,
      triggeringEntryId: 'entry_1',
      promoCode: null,
      settlement: { ...SETTLEMENT, stripePaymentIntentId: 'pi_9' },
    });
    expect(mockApplyLedgerEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        reason: 'auto_topup',
        idempotencyKey: 'auto_topup:wallet_1:entry_1',
        memberId: null,
      })
    );
    // auto_topup never surfaces a top-up receipt (its own lane owns any signal).
    expect(postCommit).toEqual([]);
    expect(mockNotificationPublish).not.toHaveBeenCalled();
  });

  it('activates the mandate via applyMandate', async () => {
    await applyStripeEffect(tx, {
      kind: 'mandate_active',
      walletId: 'wallet_1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      mandateRef: 'seti_1',
    });
    expect(mockApplyMandate).toHaveBeenCalledWith(tx, {
      walletId: 'wallet_1',
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_1',
      mandateRef: 'seti_1',
      mandateStatus: 'active',
    });
  });

  it('flips the mandate to failed via applyMandateStatus', async () => {
    await applyStripeEffect(tx, { kind: 'mandate_failed', walletId: 'wallet_1' });
    expect(mockApplyMandateStatus).toHaveBeenCalledWith(tx, 'wallet_1', 'failed');
  });

  it('logs a non-overdraft charge_failed without any DB write or post-commit effect', async () => {
    const postCommit = await applyStripeEffect(tx, {
      kind: 'charge_failed',
      walletId: 'wallet_1',
      paymentIntentId: 'pi_2',
      code: 'card_declined',
      outcome: { type: 'blocked', reason: 'highest_risk_level' },
      reason: 'auto_topup',
      sessionId: null,
    });
    expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    expect(mockMarkSettlementResult).not.toHaveBeenCalled();
    expect(mockReceivableOpen).not.toHaveBeenCalled();
    expect(postCommit).toEqual([]);
  });

  it('records a dispute audit row', async () => {
    await applyStripeEffect(tx, {
      kind: 'dispute',
      walletId: 'wallet_1',
      disputeId: 'dp_1',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      amountMinor: 7600,
      currency: 'aud',
      reason: 'fraudulent',
    });
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        action: 'credit_wallet.dispute_opened',
        entityType: 'credit_wallet',
        entityId: 'wallet_1',
        metadata: expect.objectContaining({ disputeId: 'dp_1', chargeId: 'ch_1' }),
      }),
      tx
    );
  });

  it('applies an overdraft_settlement credit, marks the session settled, clears the receivable + publishes (BAL-378)', async () => {
    mockSessionFindById.mockResolvedValue({
      id: 'session_1',
      companyId: 'company_1',
      walletId: 'wallet_1',
      expertProfileId: 'expert_1',
      overdraftSettledMinor: 7600,
    });
    const postCommit = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'overdraft_settlement',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: 'session_1',
      triggeringEntryId: null,
      promoCode: null,
      settlement: { ...SETTLEMENT, stripePaymentIntentId: 'pi_7' },
    });
    expect(mockApplyLedgerEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        reason: 'overdraft_settlement',
        idempotencyKey: 'overdraft_settlement:session_1',
        memberId: 'member_1',
        sessionId: 'session_1',
      })
    );
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sessionId: 'session_1',
        status: 'settled',
        stripePaymentIntentId: 'pi_7',
      })
    );
    expect(mockReceivableClear).toHaveBeenCalledWith({ sessionId: 'session_1' }, tx);

    // The settled publish is DEFERRED to post-commit.
    expect(mockPublishSessionSettled).not.toHaveBeenCalled();
    expect(postCommit).toHaveLength(1);
    await postCommit[0]?.();
    expect(mockPublishSessionSettled).toHaveBeenCalled();
  });

  it('a REPLAYED overdraft_settlement credit re-marks idempotently but never re-publishes (FIX 9)', async () => {
    mockApplyLedgerEntry.mockResolvedValue({
      deduped: true,
      entry: { id: 'ledger_1' },
      wallet: { companyId: 'company_1', balanceMinor: 17600, expiresAt: new Date('2027-01-01') },
    });
    mockSessionFindById.mockResolvedValue({
      id: 'session_1',
      companyId: 'company_1',
      walletId: 'wallet_1',
      expertProfileId: 'expert_1',
      overdraftSettledMinor: 7600,
    });
    const postCommit = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'overdraft_settlement',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: 'session_1',
      triggeringEntryId: null,
      promoCode: null,
      settlement: { ...SETTLEMENT, stripePaymentIntentId: 'pi_7' },
    });
    // The mark + clear stay (idempotent), but no post-commit receipt fires on the replay.
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ sessionId: 'session_1', status: 'settled' })
    );
    expect(mockReceivableClear).toHaveBeenCalledWith({ sessionId: 'session_1' }, tx);
    expect(postCommit).toEqual([]);
  });

  it('routes an async overdraft_settlement payment_failed → mark failed + open receivable + dun (BAL-378)', async () => {
    mockSessionFindById.mockResolvedValue({
      id: 'session_2',
      companyId: 'company_2',
      walletId: 'wallet_2',
      expertProfileId: 'expert_2',
      overdraftSettledMinor: 5000,
    });
    const postCommit = await applyStripeEffect(tx, {
      kind: 'charge_failed',
      walletId: 'wallet_2',
      paymentIntentId: 'pi_8',
      code: 'card_declined',
      outcome: null,
      reason: 'overdraft_settlement',
      sessionId: 'session_2',
    });
    expect(mockMarkSettlementResult).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sessionId: 'session_2',
        status: 'failed',
        stripePaymentIntentId: 'pi_8',
      })
    );
    expect(mockReceivableOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company_2',
        walletId: 'wallet_2',
        sessionId: 'session_2',
        amountMinor: 5000,
        reason: 'settlement_declined',
      }),
      tx
    );
    expect(mockPublishSettlementFailure).not.toHaveBeenCalled();
    expect(postCommit).toHaveLength(1);
    await postCommit[0]?.();
    expect(mockPublishSettlementFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'declined', amountMinor: 5000 })
    );
  });

  it('does NOT re-dun when the async payment_failed opens onto an already-open receivable (FIX 5)', async () => {
    mockSessionFindById.mockResolvedValue({
      id: 'session_2',
      companyId: 'company_2',
      walletId: 'wallet_2',
      expertProfileId: 'expert_2',
      overdraftSettledMinor: 5000,
    });
    // The sync end-session hard-decline path already opened this session's receivable.
    mockReceivableOpen.mockResolvedValue({ receivable: { id: 'rcv_2' }, created: false });
    const postCommit = await applyStripeEffect(tx, {
      kind: 'charge_failed',
      walletId: 'wallet_2',
      paymentIntentId: 'pi_8',
      code: 'card_declined',
      outcome: null,
      reason: 'overdraft_settlement',
      sessionId: 'session_2',
    });
    expect(mockReceivableOpen).toHaveBeenCalled();
    expect(postCommit).toEqual([]);
  });

  it('no-ops (no receivable) when the overdraft charge_failed session is missing', async () => {
    mockSessionFindById.mockResolvedValue(undefined);
    const postCommit = await applyStripeEffect(tx, {
      kind: 'charge_failed',
      walletId: 'wallet_3',
      paymentIntentId: 'pi_9',
      code: 'card_declined',
      outcome: null,
      reason: 'overdraft_settlement',
      sessionId: 'session_missing',
    });
    expect(mockMarkSettlementResult).not.toHaveBeenCalled();
    expect(mockReceivableOpen).not.toHaveBeenCalled();
    expect(postCommit).toEqual([]);
  });

  it('throws (no ledger write) when an auto_topup credit is missing triggeringEntryId', async () => {
    await expect(
      applyStripeEffect(tx, {
        kind: 'credit',
        reason: 'auto_topup',
        walletId: 'wallet_1',
        memberId: null,
        sessionId: null,
        triggeringEntryId: null,
        promoCode: null,
        settlement: SETTLEMENT,
      })
    ).rejects.toThrow(/triggeringEntryId/);
    expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
  });

  it('throws (no ledger write) when an overdraft_settlement credit is missing sessionId', async () => {
    await expect(
      applyStripeEffect(tx, {
        kind: 'credit',
        reason: 'overdraft_settlement',
        walletId: 'wallet_1',
        memberId: 'member_1',
        sessionId: null,
        triggeringEntryId: null,
        promoCode: null,
        settlement: SETTLEMENT,
      })
    ).rejects.toThrow(/sessionId/);
    expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
  });
});
