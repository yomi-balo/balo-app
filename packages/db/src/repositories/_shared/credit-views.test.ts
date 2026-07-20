import { describe, it, expect } from 'vitest';
import type { CreditWallet, CreditLedgerEntry, CreditSession } from '../../schema';
import {
  CLIENT_WALLET_VIEW_COLUMNS,
  toClientWalletView,
  balanceContribution,
  toLedgerActivityView,
  CLIENT_SESSION_MONEY_COLUMNS,
  EXPERT_SESSION_MONEY_COLUMNS,
  toClientMoneyBlock,
  toExpertMoneyBlock,
  toAdminMoneyBlock,
} from './credit-views';

/**
 * Unit tests for the PURE client-lens mappers (BAL-376). These make the
 * negative-assertion invariants #1/#2/#8 MEANINGFUL — they assert against concrete
 * functions, so a regression that leaks a secret / fee figure / an FX-derived balance
 * FAILS here. Mocks nothing (no `db`, no I/O).
 */

// The mandate secrets / off-lens columns that must NEVER appear on a client lens
// (invariant #1). Includes the BAL-382 mandate customer + lifecycle columns.
const WALLET_SECRET_KEYS = [
  'stripePaymentMethodId',
  'mandateRef',
  'stripeCustomerId',
  'mandateStatus',
] as const;
// Fee/margin/quote keys that must NEVER appear on a client activity row (invariant #2).
const FEE_KEYS = ['baloFeeBps', 'margin', 'markup', 'expertQuote', 'priceCents', 'rateCents'];

function fullWallet(overrides: Partial<CreditWallet> = {}): CreditWallet {
  return {
    id: 'wal_1',
    companyId: 'co_1',
    balanceMinor: 12_345,
    currency: 'AUD',
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    overdraftCeilingMinor: null,
    lowBalanceMode: 'notify_only',
    topupThresholdMinor: 2000,
    topupReloadMinor: 10_000,
    // Secrets deliberately POPULATED — the mapper must still never surface them.
    stripePaymentMethodId: 'pm_secret_123',
    mandateRef: 'mandate_secret_abc',
    stripeCustomerId: 'cus_secret_123',
    mandateStatus: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function ledgerEntry(overrides: Partial<CreditLedgerEntry> = {}): CreditLedgerEntry {
  return {
    id: 'led_1',
    seq: 1,
    walletId: 'wal_1',
    entryType: 'purchase',
    reason: 'manual_purchase',
    amountMinor: 1000,
    balanceAfterMinor: 1000,
    memberId: null,
    sessionId: null,
    chargedCurrency: null,
    chargedAmountMinor: null,
    fxRate: null,
    stripePaymentIntentId: null,
    stripeChargeId: null,
    stripeBalanceTransactionId: null,
    idempotencyKey: 'manual_purchase:pi_1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('CLIENT_WALLET_VIEW_COLUMNS (invariant #1 — no secret on a client lens)', () => {
  it('excludes the mandate secret columns from the projection allow-list', () => {
    const keys = Object.keys(CLIENT_WALLET_VIEW_COLUMNS);
    for (const secret of WALLET_SECRET_KEYS) {
      expect(keys).not.toContain(secret);
    }
  });

  it('projects only PII-safe columns (the exact allow-list)', () => {
    expect(Object.keys(CLIENT_WALLET_VIEW_COLUMNS).sort()).toEqual(
      [
        'balanceMinor',
        'companyId',
        'currency',
        'expiresAt',
        'id',
        'lowBalanceMode',
        'overdraftCeilingMinor',
        'topupReloadMinor',
        'topupThresholdMinor',
      ].sort()
    );
  });
});

describe('toClientWalletView (invariant #1 — secrets never leak even from a full row)', () => {
  it('never emits stripePaymentMethodId / mandateRef, even when the source row carries them', () => {
    const view = toClientWalletView(fullWallet(), 9000);
    const keys = Object.keys(view);
    for (const secret of WALLET_SECRET_KEYS) {
      expect(keys).not.toContain(secret);
    }
    // Belt-and-suspenders: the secret VALUES appear nowhere in the serialized view.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('pm_secret_123');
    expect(serialized).not.toContain('mandate_secret_abc');
    expect(serialized).not.toContain('cus_secret_123');
  });

  it('carries the available balance and the projected safe fields through', () => {
    const view = toClientWalletView(fullWallet({ balanceMinor: 50_000 }), 42_000);
    expect(view.balanceMinor).toBe(50_000);
    expect(view.availableMinor).toBe(42_000);
    expect(view.currency).toBe('AUD');
    expect(view.companyId).toBe('co_1');
  });
});

describe('balanceContribution (invariant #8 — only amount_minor moves the balance)', () => {
  it('returns amount_minor REGARDLESS of charged_currency / charged_amount / fx_rate', () => {
    expect(
      balanceContribution({
        amountMinor: 1000,
        chargedCurrency: 'GBP',
        chargedAmountMinor: 520,
        fxRate: '0.52',
      })
    ).toBe(1000);
  });

  it('ignores a wildly different charged figure entirely', () => {
    expect(
      balanceContribution({
        amountMinor: -2500,
        chargedCurrency: 'USD',
        chargedAmountMinor: 999_999,
        fxRate: '400.00000000',
      })
    ).toBe(-2500);
  });

  it('equals amount_minor when there are no charged/fx fields at all (AUD-native)', () => {
    expect(
      balanceContribution({
        amountMinor: 7777,
        chargedCurrency: null,
        chargedAmountMinor: null,
        fxRate: null,
      })
    ).toBe(7777);
  });
});

describe('toLedgerActivityView (invariant #2 — no margin/markup/fee/quote on a client row)', () => {
  it('carries NO fee/margin/markup/expert-quote keys for a promo entry', () => {
    const view = toLedgerActivityView(ledgerEntry({ reason: 'promo', entryType: 'adjustment' }));
    const serialized = JSON.stringify(view);
    for (const feeKey of FEE_KEYS) {
      expect(Object.keys(view)).not.toContain(feeKey);
      expect(serialized).not.toContain(feeKey);
    }
  });

  it('carries NO fee/margin/markup/expert-quote keys for an overdraft-settlement entry', () => {
    const view = toLedgerActivityView(
      ledgerEntry({
        reason: 'overdraft_settlement',
        entryType: 'purchase',
        amountMinor: 3000,
        chargedCurrency: 'GBP',
        chargedAmountMinor: 1560,
        fxRate: '0.52000000',
        // Sentinel Stripe reconciliation triplet — populated (not null) so the "never in a client
        // view" guarantee for these record-only columns is actually exercised, not vacuous.
        stripePaymentIntentId: 'pi_secret_settle_1',
        stripeChargeId: 'ch_secret_settle_1',
        stripeBalanceTransactionId: 'txn_secret_settle_1',
      })
    );
    const serialized = JSON.stringify(view);
    for (const feeKey of FEE_KEYS) {
      expect(Object.keys(view)).not.toContain(feeKey);
    }
    // The charged_* fields are surfaced ONLY under the labelled display block…
    expect(view.display).toEqual({
      chargedCurrency: 'GBP',
      chargedAmountMinor: 1560,
      fxRate: '0.52000000',
    });
    // …and never as top-level keys, and the Stripe reconciliation triplet is not exposed —
    // neither as keys nor by value anywhere in the serialized client row (invariant #6).
    expect(Object.keys(view)).not.toContain('stripePaymentIntentId');
    expect(Object.keys(view)).not.toContain('stripeChargeId');
    expect(Object.keys(view)).not.toContain('stripeBalanceTransactionId');
    expect(Object.keys(view)).not.toContain('chargedCurrency');
    expect(serialized).not.toContain('pi_secret_settle_1');
    expect(serialized).not.toContain('ch_secret_settle_1');
    expect(serialized).not.toContain('txn_secret_settle_1');
  });

  it('sets display to null when there is no charged record (a pure AUD entry)', () => {
    const view = toLedgerActivityView(ledgerEntry());
    expect(view.display).toBeNull();
    expect(view.amountMinor).toBe(1000);
    expect(view.entryType).toBe('purchase');
  });
});

// ── Money-block lens invariants (BAL-399) — fee-concealment core ────────────────────────
//
// A sentinel session with EVERY off-lens field POPULATED (expert rate, fee bps, accrual, the
// Stripe reference, the overdraft). The serializers read only the allow-listed columns, so the
// off-lens VALUES must appear nowhere in the client/expert output — asserted on both
// `Object.keys` AND the serialized string. The admin positive assertion proves the negatives
// above are not vacuous; the pending case proves a not-yet-finalized receipt zeroes every figure.

// Digit-disjoint sentinels so a legitimate own-side figure never accidentally CONTAINS a
// forbidden one as a substring (e.g. a fee bps hiding inside the expert earnings).
const EXPERT_MINUTE_SENTINEL = 2071; // raw expert rate/min — must never reach a client
const FEE_BPS_SENTINEL = 6789; // markup bps — must never reach a client or expert
const EXPERT_ACCRUED_SENTINEL = 93_195; // finalized expert pay (45 × 2071) — must never reach a client
const STRIPE_PI_SENTINEL = 'pi_secret_settle_1'; // reconciliation ref — must never reach either lens
const CLIENT_MINUTE_SENTINEL = 3040; // client rate/min — must never reach an expert

function fullSession(overrides: Partial<CreditSession> = {}): CreditSession {
  return {
    id: 'session_1',
    walletId: 'wal_1',
    companyId: 'co_1',
    expertProfileId: 'exp_1',
    initiatingMemberId: 'user_1',
    holdId: null,
    status: 'ended',
    settlementStatus: 'not_required',
    durationSource: 'live_capture',
    estimatedMinutes: 60,
    // Off-lens economics — DELIBERATELY populated so the "never surfaces" guarantee is exercised.
    expertRateMinorPerHour: 150_000,
    baloFeeBps: FEE_BPS_SENTINEL,
    clientRateMinorPerMinute: CLIENT_MINUTE_SENTINEL,
    expertRateMinorPerMinute: EXPERT_MINUTE_SENTINEL,
    effectiveCeilingMinor: 15_000,
    graceBoundMinutes: 30,
    connectedAt: new Date('2026-07-20T12:00:00Z'),
    lastTickSeq: 45,
    connectedMinutes: 45,
    expertAccruedMinor: EXPERT_ACCRUED_SENTINEL,
    lowWarnedAt: null,
    graceEnteredAt: null,
    nearWrapWarnedAt: null,
    wrappedAt: null,
    endedAt: new Date('2026-07-20T12:45:00Z'),
    settledAt: new Date('2026-07-20T12:45:05Z'),
    overdraftSettledMinor: 4500,
    billingFinalizedAt: new Date('2026-07-20T12:45:05Z'),
    finalizationPath: 'live_capture',
    stripePaymentIntentId: STRIPE_PI_SENTINEL,
    createdAt: new Date('2026-07-20T11:00:00Z'),
    updatedAt: new Date('2026-07-20T12:45:05Z'),
    deletedAt: null,
    ...overrides,
  };
}

// Invariant #4 — the projection allow-lists structurally exclude the counterparty economics.
describe('money-block projection allow-lists (invariant #4)', () => {
  it('CLIENT_SESSION_MONEY_COLUMNS excludes expertRate* / baloFeeBps / expertAccruedMinor / stripePaymentIntentId', () => {
    const keys = Object.keys(CLIENT_SESSION_MONEY_COLUMNS);
    for (const excluded of [
      'expertRateMinorPerHour',
      'expertRateMinorPerMinute',
      'expertAccruedMinor',
      'baloFeeBps',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(excluded);
    }
  });

  it('EXPERT_SESSION_MONEY_COLUMNS excludes clientRate* / baloFeeBps / overdraftSettledMinor / stripePaymentIntentId', () => {
    const keys = Object.keys(EXPERT_SESSION_MONEY_COLUMNS);
    for (const excluded of [
      'clientRateMinorPerMinute',
      'baloFeeBps',
      'overdraftSettledMinor',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(excluded);
    }
  });
});

// Invariant #1 — the client money block never carries an expert / fee / margin / Stripe figure.
describe('toClientMoneyBlock (invariant #1 — no expert economics / fee / margin on a client lens)', () => {
  it('never emits expertRate* / expertAccruedMinor / baloFeeBps / margin / stripePaymentIntentId — keys and values', () => {
    const block = toClientMoneyBlock(fullSession());
    const keys = Object.keys(block);
    for (const forbidden of [
      'expertRateMinorPerMinute',
      'expertRateMinorPerHour',
      'expertAccruedMinor',
      'baloFeeBps',
      'marginAudMinor',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    const serialized = JSON.stringify(block);
    expect(serialized).not.toContain(String(EXPERT_MINUTE_SENTINEL));
    expect(serialized).not.toContain(String(EXPERT_ACCRUED_SENTINEL));
    expect(serialized).not.toContain(STRIPE_PI_SENTINEL);
    // The all-in charge IS surfaced (client-safe) and equals connectedMinutes × client rate.
    expect(block.amountAudMinor).toBe(45 * CLIENT_MINUTE_SENTINEL);
  });
});

// Invariant #2 — the expert money block never carries a client charge / fee / margin / overdraft.
describe('toExpertMoneyBlock (invariant #2 — own earnings only)', () => {
  it('never emits clientRate* / baloFeeBps / margin / overdraftSettledMinor / stripePaymentIntentId — keys and values', () => {
    const block = toExpertMoneyBlock(fullSession(), 'recorded');
    const keys = Object.keys(block);
    for (const forbidden of [
      'clientRateMinorPerMinute',
      'amountAudMinor',
      'clientChargeAudMinor',
      'baloFeeBps',
      'marginAudMinor',
      'overdraftSettledMinor',
      'stripePaymentIntentId',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    const serialized = JSON.stringify(block);
    expect(serialized).not.toContain(String(CLIENT_MINUTE_SENTINEL));
    expect(serialized).not.toContain(String(FEE_BPS_SENTINEL));
    expect(serialized).not.toContain(STRIPE_PI_SENTINEL);
    // Own earnings ARE surfaced.
    expect(block.earningsAudMinor).toBe(EXPERT_ACCRUED_SENTINEL);
    expect(block.payoutStatus).toBe('recorded');
  });
});

// Invariant #3 — admin is the SOLE lens where margin / fee appear (proves #1/#2 aren't vacuous).
describe('toAdminMoneyBlock (invariant #3 — the sole margin-bearing lens)', () => {
  it('surfaces marginAudMinor + baloFeeBps from the snapshots', () => {
    const block = toAdminMoneyBlock(fullSession());
    expect(block.baloFeeBps).toBe(FEE_BPS_SENTINEL);
    expect(block.clientChargeAudMinor).toBe(45 * CLIENT_MINUTE_SENTINEL);
    expect(block.expertEarningsAudMinor).toBe(EXPERT_ACCRUED_SENTINEL);
    expect(block.marginAudMinor).toBe(45 * CLIENT_MINUTE_SENTINEL - EXPERT_ACCRUED_SENTINEL);
    expect(block.overdraftSettledMinor).toBe(4500);
  });
});

// Invariant #5 — a pending (not-yet-finalized) receipt zeroes every money figure on every lens.
describe('money-block pending state (invariant #5 — never leaks the finalized number)', () => {
  const pending = fullSession({ billingFinalizedAt: null, finalizationPath: null });

  it('client pending zeroes the all-in charge and duration', () => {
    const block = toClientMoneyBlock(pending);
    expect(block.state).toBe('pending');
    expect(block.amountAudMinor).toBe(0);
    expect(block.durationMinutes).toBe(0);
    expect(JSON.stringify(block)).not.toContain(String(45 * CLIENT_MINUTE_SENTINEL));
  });

  it('expert pending zeroes earnings and duration', () => {
    const block = toExpertMoneyBlock(pending, 'recorded');
    expect(block.state).toBe('pending');
    expect(block.earningsAudMinor).toBe(0);
    expect(block.durationMinutes).toBe(0);
    expect(JSON.stringify(block)).not.toContain(String(EXPERT_ACCRUED_SENTINEL));
  });

  it('admin pending zeroes client charge, expert earnings, and margin', () => {
    const block = toAdminMoneyBlock(pending);
    expect(block.state).toBe('pending');
    expect(block.clientChargeAudMinor).toBe(0);
    expect(block.expertEarningsAudMinor).toBe(0);
    expect(block.marginAudMinor).toBe(0);
    expect(block.overdraftSettledMinor).toBe(0);
  });
});
