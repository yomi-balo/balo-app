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
  promoRedemptionsRepository: { redeem: mockRedeem },
  deriveIdempotencyKey: mockDeriveIdempotencyKey,
  db: {},
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
  });

  it('applies a manual_purchase credit via applyLedgerEntry with the PI-keyed idempotency key', async () => {
    const result = await applyStripeEffect(tx, {
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
    // Fresh manual_purchase → a receipt for the post-commit publish (no promo → 0 bonus).
    expect(result).toEqual({
      kind: 'credit_topup_receipt',
      receipt: expect.objectContaining({
        correlationId: 'manual_purchase:pi_1',
        walletId: 'wallet_1',
        companyId: 'company_1',
        purchaserUserId: 'member_1',
        creditedMinor: 7600,
        promoGrantedMinor: 0,
        balanceAfterMinor: 17600,
      }),
    });
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('grants a promo best-effort on a manual_purchase and reflects it in the receipt', async () => {
    mockRedeem.mockResolvedValue({ outcome: 'redeemed', grantMinor: 5000, ledgerEntryId: 'le_2' });
    const result = await applyStripeEffect(tx, {
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
    expect(result).toMatchObject({
      kind: 'credit_topup_receipt',
      receipt: { promoGrantedMinor: 5000, balanceAfterMinor: 22600 },
    });
  });

  it('skips a promo that failed re-validation at settlement (base purchase still credits)', async () => {
    mockRedeem.mockRejectedValue(new Error('PromoExhaustedError'));
    const result = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'manual_purchase',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: null,
      triggeringEntryId: null,
      promoCode: 'WELCOME50',
      settlement: SETTLEMENT,
    });
    // Base purchase credited; promo skipped → 0 bonus, receipt still published.
    expect(mockApplyLedgerEntry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: 'credit_topup_receipt',
      receipt: { promoGrantedMinor: 0, balanceAfterMinor: 17600 },
    });
  });

  it('does not re-grant or surface a receipt on a deduped (replayed) manual_purchase credit', async () => {
    mockApplyLedgerEntry.mockResolvedValueOnce({
      deduped: true,
      entry: { id: 'ledger_1' },
      wallet: { companyId: 'company_1', balanceMinor: 17600, expiresAt: new Date('2027-01-01') },
    });
    const result = await applyStripeEffect(tx, {
      kind: 'credit',
      reason: 'manual_purchase',
      walletId: 'wallet_1',
      memberId: 'member_1',
      sessionId: null,
      triggeringEntryId: null,
      promoCode: 'WELCOME50',
      settlement: SETTLEMENT,
    });
    expect(result).toBeNull();
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('applies an auto_topup credit with the wallet+entry-keyed idempotency key', async () => {
    const result = await applyStripeEffect(tx, {
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
    expect(result).toBeNull();
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

  it('logs charge_failed without any DB write', async () => {
    await applyStripeEffect(tx, {
      kind: 'charge_failed',
      walletId: 'wallet_1',
      paymentIntentId: 'pi_2',
      code: 'card_declined',
      outcome: { type: 'blocked', reason: 'highest_risk_level' },
    });
    expect(mockApplyLedgerEntry).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
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

  it('applies an overdraft_settlement credit with the session-keyed idempotency key (BAL-378 path)', async () => {
    await applyStripeEffect(tx, {
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
