import { describe, it, expect } from 'vitest';
import type { SessionMoneyBlock } from './money-block';
import { durationLine, finalizedAmountMinor } from './money-block-display';

const CLIENT_FINALIZED: SessionMoneyBlock = {
  lens: 'client',
  state: 'finalized',
  sessionId: 'session_1',
  durationMinutes: 45,
  amountAudMinor: 15_000,
  ratePerMinuteMinor: 333,
  settlementStatus: 'not_required',
  finalizationPath: 'live_capture',
  actualMinutes: 45,
  billingFloorApplied: false,
  billingFloorMinutes: 0,
};

const EXPERT_FINALIZED: SessionMoneyBlock = {
  lens: 'expert',
  state: 'finalized',
  sessionId: 'session_1',
  durationMinutes: 45,
  earningsAudMinor: 11_250,
  payoutStatus: 'recorded',
  finalizationPath: 'live_capture',
  actualMinutes: 45,
  billingFloorApplied: false,
  billingFloorMinutes: 0,
};

const CLIENT_FLOOR_APPLIED: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 15,
  amountAudMinor: 5_000,
  actualMinutes: 6,
  billingFloorApplied: true,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'held',
};

const EXPERT_FLOOR_APPLIED: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 15,
  earningsAudMinor: 3_750,
  actualMinutes: 6,
  billingFloorApplied: true,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'held',
};

const CLIENT_NO_SHOW: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 15,
  amountAudMinor: 5_000,
  actualMinutes: 18,
  billingFloorApplied: true,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'no_show_client',
};

const EXPERT_NO_SHOW: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 15,
  earningsAudMinor: 3_750,
  actualMinutes: 18,
  billingFloorApplied: true,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'no_show_client',
};

const CLIENT_MISSED_CALL: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 0,
  amountAudMinor: 0,
  actualMinutes: 0,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'missed_call',
};

const EXPERT_MISSED_CALL: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 0,
  earningsAudMinor: 0,
  actualMinutes: 0,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'missed_call',
};

const CLIENT_ABANDONED_WAIT: SessionMoneyBlock = {
  ...CLIENT_FINALIZED,
  durationMinutes: 0,
  amountAudMinor: 0,
  actualMinutes: 8,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'abandoned_wait',
};

const EXPERT_ABANDONED_WAIT: SessionMoneyBlock = {
  ...EXPERT_FINALIZED,
  durationMinutes: 0,
  earningsAudMinor: 0,
  actualMinutes: 8,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  finalizationPath: 'presence',
  settlementShape: 'abandoned_wait',
};

/** Presence not read — the default a caller must now state explicitly. */
const NOT_READ = { clientSideEverPresent: null } as const;

describe('durationLine', () => {
  it('renders a bare duration line with no floor and no settlement shape', () => {
    expect(durationLine(CLIENT_FINALIZED, NOT_READ)).toBe('45 min');
    expect(durationLine(EXPERT_FINALIZED, NOT_READ)).toBe('45 min');
  });

  it('renders the split "actual · billed/paid at the floor" line when the floor bound', () => {
    expect(durationLine(CLIENT_FLOOR_APPLIED, NOT_READ)).toBe(
      '6 min · billed at the 15-minute minimum'
    );
    expect(durationLine(EXPERT_FLOOR_APPLIED, NOT_READ)).toBe('6 min · paid the 15-minute minimum');
  });

  it('renders the no-show line keyed on shape, using actualMinutes not durationMinutes', () => {
    expect(durationLine(CLIENT_NO_SHOW, NOT_READ)).toBe(
      '18 min held · billed at the 15-minute minimum'
    );
    expect(durationLine(EXPERT_NO_SHOW, NOT_READ)).toBe('18 min held · paid the 15-minute minimum');
  });

  it('renders the missed-call line, per lens', () => {
    expect(durationLine(CLIENT_MISSED_CALL, NOT_READ)).toBe(
      "Not charged — your consultant didn't join this time"
    );
    expect(durationLine(EXPERT_MISSED_CALL, NOT_READ)).toBe(
      "No earnings recorded — the call didn't take place"
    );
  });

  it('names nobody on the client lens when NO client-side participant was ever present', () => {
    expect(durationLine(CLIENT_MISSED_CALL, { clientSideEverPresent: false })).toBe(
      'Not charged — nobody joined this time'
    );
  });

  it('keeps the consultant line when the client side was present, or presence is unknown', () => {
    const consultantLine = "Not charged — your consultant didn't join this time";
    expect(durationLine(CLIENT_MISSED_CALL, { clientSideEverPresent: true })).toBe(consultantLine);
    expect(durationLine(CLIENT_MISSED_CALL, { clientSideEverPresent: null })).toBe(consultantLine);
  });

  it('keeps the expert missed-call line whatever the client-side presence', () => {
    for (const clientSideEverPresent of [false, true, null]) {
      expect(durationLine(EXPERT_MISSED_CALL, { clientSideEverPresent })).toBe(
        "No earnings recorded — the call didn't take place"
      );
    }
  });

  it('ignores client-side presence on every non-missed-call shape', () => {
    for (const block of [CLIENT_FINALIZED, CLIENT_NO_SHOW, CLIENT_ABANDONED_WAIT]) {
      expect(durationLine(block, { clientSideEverPresent: false })).toBe(
        durationLine(block, NOT_READ)
      );
    }
  });

  it('renders the abandoned-wait line, per lens, WITHOUT actualMinutes', () => {
    expect(durationLine(CLIENT_ABANDONED_WAIT, NOT_READ)).toBe('Not charged');
    expect(durationLine(EXPERT_ABANDONED_WAIT, NOT_READ)).toBe('No earnings recorded');
  });
});

describe('finalizedAmountMinor', () => {
  it('reads the all-in charge on the client lens', () => {
    expect(finalizedAmountMinor(CLIENT_FINALIZED)).toBe(15_000);
  });

  it('reads own earnings on the expert lens', () => {
    expect(finalizedAmountMinor(EXPERT_FINALIZED)).toBe(11_250);
  });
});
