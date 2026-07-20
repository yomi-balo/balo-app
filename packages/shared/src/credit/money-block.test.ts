import { describe, it, expect } from 'vitest';
import {
  buildClientMoneyBlock,
  buildExpertMoneyBlock,
  buildAdminMoneyBlock,
  type ClientMoneyBlockInput,
  type ExpertMoneyBlockInput,
  type AdminMoneyBlockInput,
} from './money-block';

/**
 * Pure-builder unit tests (BAL-399). These prove the pending/finalized discriminant and the
 * fee-concealment shape at the DISPLAY layer: the client builder never emits an expert figure,
 * the expert builder never emits a client figure, and only the admin builder carries margin.
 * The DB projection (credit-views) is the STRUCTURAL boundary; these guard the arithmetic.
 */

const FINALIZED = new Date('2026-07-20T12:00:00Z');

function clientInput(overrides: Partial<ClientMoneyBlockInput> = {}): ClientMoneyBlockInput {
  return {
    sessionId: 'session_1',
    connectedMinutes: 45,
    clientRateMinorPerMinute: 333, // A$3.33/min → 45 min = A$149.85
    settlementStatus: 'not_required',
    billingFinalizedAt: FINALIZED,
    finalizationPath: 'live_capture',
    ...overrides,
  };
}

function expertInput(overrides: Partial<ExpertMoneyBlockInput> = {}): ExpertMoneyBlockInput {
  return {
    sessionId: 'session_1',
    connectedMinutes: 45,
    expertAccruedMinor: 11_250, // A$112.50
    billingFinalizedAt: FINALIZED,
    finalizationPath: 'live_capture',
    ...overrides,
  };
}

function adminInput(overrides: Partial<AdminMoneyBlockInput> = {}): AdminMoneyBlockInput {
  return {
    sessionId: 'session_1',
    connectedMinutes: 45,
    clientRateMinorPerMinute: 333,
    expertAccruedMinor: 11_250,
    baloFeeBps: 2500,
    overdraftSettledMinor: 4500,
    billingFinalizedAt: FINALIZED,
    finalizationPath: 'live_capture',
    ...overrides,
  };
}

describe('buildClientMoneyBlock', () => {
  it('derives the all-in charge from connectedMinutes × rate when finalized', () => {
    const block = buildClientMoneyBlock(clientInput());
    expect(block.state).toBe('finalized');
    expect(block.durationMinutes).toBe(45);
    expect(block.amountAudMinor).toBe(45 * 333);
    expect(block.ratePerMinuteMinor).toBe(333);
    expect(block.finalizationPath).toBe('live_capture');
  });

  it('zeroes every money figure while pending (never leaks a finalized number)', () => {
    const block = buildClientMoneyBlock(
      clientInput({ billingFinalizedAt: null, finalizationPath: null })
    );
    expect(block.state).toBe('pending');
    expect(block.durationMinutes).toBe(0);
    expect(block.amountAudMinor).toBe(0);
    expect(block.finalizationPath).toBeUndefined();
  });

  it('never emits an expert / fee / margin key', () => {
    const keys = Object.keys(buildClientMoneyBlock(clientInput()));
    for (const forbidden of [
      'earningsAudMinor',
      'expertAccruedMinor',
      'baloFeeBps',
      'marginAudMinor',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('buildExpertMoneyBlock', () => {
  it('surfaces own earnings only when finalized', () => {
    const block = buildExpertMoneyBlock(expertInput({ payoutStatus: 'recorded' }));
    expect(block.state).toBe('finalized');
    expect(block.durationMinutes).toBe(45);
    expect(block.earningsAudMinor).toBe(11_250);
    expect(block.payoutStatus).toBe('recorded');
  });

  it('zeroes earnings while pending, keeps a payout status if present', () => {
    const block = buildExpertMoneyBlock(
      expertInput({ billingFinalizedAt: null, finalizationPath: null })
    );
    expect(block.state).toBe('pending');
    expect(block.earningsAudMinor).toBe(0);
    expect(block.durationMinutes).toBe(0);
  });

  it('never emits a client charge / fee / margin key', () => {
    const keys = Object.keys(buildExpertMoneyBlock(expertInput()));
    for (const forbidden of [
      'amountAudMinor',
      'clientChargeAudMinor',
      'baloFeeBps',
      'marginAudMinor',
      'overdraftSettledMinor',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('buildAdminMoneyBlock', () => {
  it('computes margin = clientCharge − expertEarnings from snapshots', () => {
    const block = buildAdminMoneyBlock(adminInput());
    expect(block.clientChargeAudMinor).toBe(45 * 333);
    expect(block.expertEarningsAudMinor).toBe(11_250);
    expect(block.marginAudMinor).toBe(45 * 333 - 11_250);
    expect(block.baloFeeBps).toBe(2500);
    expect(block.overdraftSettledMinor).toBe(4500);
  });

  it('zeroes every money figure (incl. margin) while pending', () => {
    const block = buildAdminMoneyBlock(
      adminInput({ billingFinalizedAt: null, finalizationPath: null })
    );
    expect(block.state).toBe('pending');
    expect(block.clientChargeAudMinor).toBe(0);
    expect(block.expertEarningsAudMinor).toBe(0);
    expect(block.marginAudMinor).toBe(0);
    expect(block.overdraftSettledMinor).toBe(0);
  });
});
