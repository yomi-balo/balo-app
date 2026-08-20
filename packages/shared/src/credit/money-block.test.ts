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
    // BAL-412 — a `live_capture` session's "actual" duration IS its connected minutes.
    actualMinutes: 45,
    billingFloorMinutes: 0,
    // BAL-412 (R2) — the persisted `credit_sessions.floor_applied` snapshot. `false` on a
    // `live_capture` row: no floor was ever in force there.
    floorApplied: false,
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
    actualMinutes: 45,
    billingFloorMinutes: 0,
    floorApplied: false,
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
    actualMinutes: 45,
    billingFloorMinutes: 0,
    floorApplied: false,
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

// BAL-412 (ADR-1044 §7, §7.2) — the actual-vs-billed split + settlement shape, on all three
// builders. Concealment re-asserted: these four fields are DURATIONS AND LABELS, so they are
// deliberately identical across lenses — never a rate, margin or fee.
describe('BAL-412 — actualMinutes / billingFloorApplied / billingFloorMinutes / settlementShape', () => {
  it('client: floor bound (6 actual, 15 billed) sets billingFloorApplied', () => {
    const block = buildClientMoneyBlock(
      clientInput({
        connectedMinutes: 15,
        actualMinutes: 6,
        billingFloorMinutes: 15,
        floorApplied: true,
        settlementShape: 'held',
        finalizationPath: 'presence',
      })
    );
    expect(block.actualMinutes).toBe(6);
    expect(block.billingFloorMinutes).toBe(15);
    expect(block.billingFloorApplied).toBe(true);
    expect(block.settlementShape).toBe('held');
  });

  it('client: a no_show billed the FLAT floor (40 actual, 15 billed) still reports the floor applied', () => {
    // R1 — `no_show_client` bills the floor FLAT (owner ruling, 2026-08-21), so the BILLED figure
    // (15) is BELOW `actualMinutes` (40). The old re-derivation `durationMinutes > actualMinutes`
    // reported `false` here — on the very shape where the floor IS the entire charge. The
    // snapshot says `true`, and the recap's "40 min held · billed at the 15-minute minimum" is
    // now a true statement.
    const block = buildClientMoneyBlock(
      clientInput({
        connectedMinutes: 15,
        actualMinutes: 40,
        billingFloorMinutes: 15,
        floorApplied: true,
        settlementShape: 'no_show_client',
        finalizationPath: 'presence',
      })
    );
    expect(block.durationMinutes).toBe(15);
    expect(block.actualMinutes).toBe(40);
    expect(block.billingFloorApplied).toBe(true);
    expect(block.settlementShape).toBe('no_show_client');
  });

  it('client: the Q1 no-refund clamp is NOT reported as a floor application (R2/F14)', () => {
    // THE REGRESSION THIS FINDING IS ABOUT. Billable 10 > actual 6 purely because 10 minutes were
    // already drawn (rule was 6, no floor in force). The rejected re-derivation
    // `durationMinutes > actualMinutes` would say `true` and the recap would print "billed at the
    // minimum", masking a real overcharge as routine. The persisted snapshot says `false`.
    const block = buildClientMoneyBlock(
      clientInput({
        connectedMinutes: 10,
        actualMinutes: 6,
        billingFloorMinutes: 15,
        floorApplied: false,
        settlementShape: 'held',
        finalizationPath: 'presence',
      })
    );
    expect(block.durationMinutes).toBeGreaterThan(block.actualMinutes);
    expect(block.billingFloorApplied).toBe(false);
  });

  it('expert: identical split to the client lens for the same session', () => {
    const block = buildExpertMoneyBlock(
      expertInput({
        connectedMinutes: 15,
        actualMinutes: 6,
        billingFloorMinutes: 15,
        floorApplied: true,
        settlementShape: 'held',
        finalizationPath: 'presence',
      })
    );
    expect(block.actualMinutes).toBe(6);
    expect(block.billingFloorApplied).toBe(true);
    expect(block.settlementShape).toBe('held');
  });

  it('expert: the Q1 no-refund clamp is NOT reported as a floor application (R2/F14)', () => {
    const block = buildExpertMoneyBlock(
      expertInput({ connectedMinutes: 10, actualMinutes: 6, floorApplied: false })
    );
    expect(block.durationMinutes).toBeGreaterThan(block.actualMinutes);
    expect(block.billingFloorApplied).toBe(false);
  });

  it('admin: identical split, alongside the margin figures', () => {
    const block = buildAdminMoneyBlock(
      adminInput({
        connectedMinutes: 15,
        actualMinutes: 6,
        billingFloorMinutes: 15,
        floorApplied: true,
        settlementShape: 'held',
        finalizationPath: 'presence',
      })
    );
    expect(block.actualMinutes).toBe(6);
    expect(block.billingFloorApplied).toBe(true);
    expect(block.settlementShape).toBe('held');
  });

  it('admin: the Q1 no-refund clamp is NOT reported as a floor application (R2/F14)', () => {
    const block = buildAdminMoneyBlock(
      adminInput({ connectedMinutes: 10, actualMinutes: 6, floorApplied: false })
    );
    expect(block.durationMinutes).toBeGreaterThan(block.actualMinutes);
    expect(block.billingFloorApplied).toBe(false);
  });

  it('pending ⇒ actualMinutes/billingFloorMinutes are 0, billingFloorApplied is false, shape absent', () => {
    const client = buildClientMoneyBlock(
      clientInput({
        billingFinalizedAt: null,
        finalizationPath: null,
        actualMinutes: 6,
        billingFloorMinutes: 15,
        // Even a `true` snapshot must be suppressed while pending — a pending receipt leaks
        // nothing derived, this field included.
        floorApplied: true,
        settlementShape: 'held',
      })
    );
    expect(client.actualMinutes).toBe(0);
    expect(client.billingFloorMinutes).toBe(0);
    expect(client.billingFloorApplied).toBe(false);
    expect(client.settlementShape).toBeUndefined();
  });

  it('settlementShape is omitted (not null) when undefined on the input', () => {
    const block = buildClientMoneyBlock(clientInput());
    expect('settlementShape' in block).toBe(false);
  });
});
