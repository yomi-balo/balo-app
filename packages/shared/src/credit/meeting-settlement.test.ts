import { describe, it, expect } from 'vitest';
import type { MeetingClocks } from '../meetings';
import {
  resolveMeetingSettlement,
  clampedExpertPresentMs,
  type MeetingSettlementInput,
} from './meeting-settlement';

const MINUTE = 60_000;
const SCHEDULED_START = new Date('2026-08-20T10:00:00.000Z');
const FLOOR_15_MS = 15 * MINUTE;
/** What `apps/api` injects — `MAX_SESSION_MINUTES`. Restated locally to keep this test pure. */
const MAX_BILLABLE_MINUTES = 240;

function clocks(overrides: Partial<MeetingClocks> = {}): MeetingClocks {
  return {
    expertPresentMs: 0,
    billableMs: 0,
    expertFirstJoinedAt: null,
    billableStartedAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<MeetingSettlementInput> = {}): MeetingSettlementInput {
  return {
    clocks: clocks(),
    scheduledStart: SCHEDULED_START,
    clientSideEverPresent: false,
    floorMs: FLOOR_15_MS,
    minutesAlreadyDrawn: 0,
    maxBillableMinutes: MAX_BILLABLE_MINUTES,
    ...overrides,
  };
}

describe('resolveMeetingSettlement — the D3 truth table', () => {
  it('#1 expert never joined ⇒ missed_call, zero, no ticks', () => {
    const result = resolveMeetingSettlement(
      input({ clocks: clocks({ expertFirstJoinedAt: null }), clientSideEverPresent: true })
    );
    expect(result.shape).toBe('missed_call');
    expect(result.outcome).toBe('missed_call');
    expect(result.billableMinutes).toBe(0);
    expect(result.actualMinutes).toBe(0);
    expect(result.floorApplied).toBe(false);
    expect(result.topUpToTickSeq).toBeLessThan(result.topUpFromTickSeq);
  });

  it('#2 expert joined, client never, ≥ floor ⇒ no_show_client, billed the FLAT floor', () => {
    const joined = SCHEDULED_START;
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: joined, expertPresentMs: 20 * MINUTE }),
        clientSideEverPresent: false,
      })
    );
    expect(result.shape).toBe('no_show_client');
    expect(result.outcome).toBe('no_show_client');
    expect(result.actualMinutes).toBe(20);
    // R1 (owner ruling, 2026-08-21) — the floor is the WHOLE charge on a no-show, not a minimum.
    // The expert waited 20; the client who never arrived is billed 15, and the expert accrues 15.
    expect(result.billableMinutes).toBe(15);
    expect(result.floorApplied).toBe(true);
  });

  it('#2b expert joined, client never, exactly at the floor ⇒ no_show_client, billed the floor', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 15 * MINUTE }),
        clientSideEverPresent: false,
      })
    );
    expect(result.shape).toBe('no_show_client');
    expect(result.actualMinutes).toBe(15);
    expect(result.billableMinutes).toBe(15);
    // R1 — `true` even here, where rule and actual coincide: the floor is definitionally what
    // fixed the figure on this shape, so `ruleMinutes > actualMinutes` alone is not the test.
    expect(result.floorApplied).toBe(true);
  });

  it('#3 (D2) expert joined, client never, BELOW floor ⇒ abandoned_wait, outcome completed, ZERO', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 8 * MINUTE }),
        clientSideEverPresent: false,
      })
    );
    expect(result.shape).toBe('abandoned_wait');
    // ⚠ D2/D3: no fourth `meeting_outcome` value — this deliberately writes `completed`.
    expect(result.outcome).toBe('completed');
    expect(result.billableMinutes).toBe(0);
    expect(result.actualMinutes).toBe(8);
    expect(result.floorApplied).toBe(false);
    expect(result.topUpToTickSeq).toBeLessThan(result.topUpFromTickSeq);
  });

  it('#4 both present ⇒ held, outcome completed, floored figure', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 6 * MINUTE }),
        clientSideEverPresent: true,
      })
    );
    expect(result.shape).toBe('held');
    expect(result.outcome).toBe('completed');
    expect(result.actualMinutes).toBe(6);
    expect(result.billableMinutes).toBe(15); // floor bound
    expect(result.floorApplied).toBe(true);
  });

  it('clientSideEverPresent=true but NO overlap (billableStartedAt null) resolves `held`, NOT `no_show_client`', () => {
    // The client joined and left BEFORE the expert arrived (ADR-1049 A2's removed guard hole).
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({
          expertFirstJoinedAt: SCHEDULED_START,
          expertPresentMs: 20 * MINUTE,
          billableMs: 0,
          billableStartedAt: null,
        }),
        clientSideEverPresent: true,
      })
    );
    expect(result.shape).toBe('held');
    expect(result.outcome).toBe('completed');
  });
});

/**
 * R1 (owner ruling, 2026-08-21) — "For client no-show, the client should only be billed 15min
 * minimum charge. The expert has to stay for this long for the client to be billed that, else, no
 * charge."
 *
 * So `no_show_client` is a FIXED FLOOR PENALTY, not "expert paid for time made available":
 * the floor is the WHOLE charge and the expert's excess wait is deliberately not billed onward.
 * `abandoned_wait` is the "else, no charge" half. `held` is untouched.
 */
describe('resolveMeetingSettlement — a client no-show bills the floor FLAT (R1)', () => {
  const noShowFor = (ms: number) =>
    resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: ms }),
        clientSideEverPresent: false,
      })
    );

  it('a 40-minute wait bills 15, NOT 40 — client charge and expert accrual are the same figure', () => {
    const result = noShowFor(40 * MINUTE);
    expect(result.shape).toBe('no_show_client');
    expect(result.actualMinutes).toBe(40);
    // ⚠ THE MONEY ASSERTION. `billableMinutes` is the ONE number both the client charge and the
    // expert accrual derive from, so this pins both halves of the AC at once.
    expect(result.billableMinutes).toBe(15);
    expect(result.ruleMinutes).toBe(15);
    expect(result.uncappedRuleMinutes).toBe(15);
    expect(result.topUpToTickSeq).toBe(15);
  });

  it('floorApplied is true on the 40-minute no-show, though rule (15) is BELOW actual (40)', () => {
    const result = noShowFor(40 * MINUTE);
    expect(result.ruleMinutes).toBeLessThan(result.actualMinutes);
    expect(result.floorApplied).toBe(true);
  });

  it('is FLAT, not a minimum — 20/40/240 minutes of waiting all bill exactly the floor', () => {
    for (const minutes of [20, 40, 240]) {
      expect(noShowFor(minutes * MINUTE).billableMinutes).toBe(15);
    }
  });

  it('tracks whatever floor the caller injects — a 20-minute floor bills 20 flat', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 40 * MINUTE }),
        clientSideEverPresent: false,
        floorMs: 20 * MINUTE,
      })
    );
    expect(result.billableMinutes).toBe(20);
  });

  it('the "else, no charge" half is unchanged — abandoned_wait at 8 minutes still bills 0', () => {
    const result = noShowFor(8 * MINUTE);
    expect(result.shape).toBe('abandoned_wait');
    expect(result.billableMinutes).toBe(0);
    expect(result.floorApplied).toBe(false);
  });

  it('`held` IS NOT TOUCHED — a real two-party 40-minute call still bills 40', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 40 * MINUTE }),
        clientSideEverPresent: true,
      })
    );
    expect(result.shape).toBe('held');
    expect(result.billableMinutes).toBe(40);
    expect(result.floorApplied).toBe(false);
  });
});

describe('resolveMeetingSettlement — the D4 clock-start clamp', () => {
  it('an early-joining expert (09:55 for a 10:00 call) is not credited for arriving early', () => {
    const earlyJoin = new Date(SCHEDULED_START.getTime() - 5 * MINUTE); // 09:55
    // Present from 09:55 to 10:20 = 25 min span, but clock starts at 10:00.
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: earlyJoin, expertPresentMs: 25 * MINUTE }),
        clientSideEverPresent: true,
      })
    );
    expect(result.effectiveExpertPresentMs).toBe(20 * MINUTE);
    expect(result.actualMinutes).toBe(20);
  });

  it('an expert joining 10:05 (5 min late) settles their no-show at 10:20, not 10:15', () => {
    const lateJoin = new Date(SCHEDULED_START.getTime() + 5 * MINUTE); // 10:05
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: lateJoin, expertPresentMs: 15 * MINUTE }),
        clientSideEverPresent: false,
      })
    );
    // Clock starts at 10:05 (later than scheduled start) — present 10:05→10:20 = 15 min.
    expect(result.effectiveExpertPresentMs).toBe(15 * MINUTE);
    expect(result.shape).toBe('no_show_client');
    expect(result.actualMinutes).toBe(15);
  });

  it('clampedExpertPresentMs is 0 when the expert never joined', () => {
    expect(clampedExpertPresentMs(clocks({ expertFirstJoinedAt: null }), SCHEDULED_START)).toBe(0);
  });

  it('clampedExpertPresentMs fails closed to 0 on a non-finite scheduledStart', () => {
    const result = clampedExpertPresentMs(
      clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 20 * MINUTE }),
      new Date('not-a-date')
    );
    expect(result).toBe(0);
  });

  it('clampedExpertPresentMs fails closed to 0 on a non-finite expertFirstJoinedAt', () => {
    const result = clampedExpertPresentMs(
      clocks({ expertFirstJoinedAt: new Date('not-a-date'), expertPresentMs: 20 * MINUTE }),
      SCHEDULED_START
    );
    expect(result).toBe(0);
  });
});

describe('resolveMeetingSettlement — ceil boundaries around the floor', () => {
  const boundaries: ReadonlyArray<{ label: string; ms: number; expectedActual: number }> = [
    { label: '0s', ms: 0, expectedActual: 0 },
    { label: '1s', ms: 1_000, expectedActual: 1 },
    { label: '59s', ms: 59_000, expectedActual: 1 },
    { label: '8min', ms: 8 * MINUTE, expectedActual: 8 },
    { label: '14:59', ms: 14 * MINUTE + 59_000, expectedActual: 15 },
    { label: '15:00', ms: 15 * MINUTE, expectedActual: 15 },
    { label: '15:01', ms: 15 * MINUTE + 1_000, expectedActual: 16 },
    { label: '22:00', ms: 22 * MINUTE, expectedActual: 22 },
    { label: '240min', ms: 240 * MINUTE, expectedActual: 240 },
  ];

  it.each(boundaries)(
    '$label: actualMinutes ceils correctly, held (client present)',
    ({ ms, expectedActual }) => {
      const result = resolveMeetingSettlement(
        input({
          clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: ms }),
          clientSideEverPresent: true,
        })
      );
      expect(result.actualMinutes).toBe(expectedActual);
      expect(result.billableMinutes).toBe(Math.max(expectedActual, 15));
    }
  );
});

describe('resolveMeetingSettlement — the floor is a PARAMETER, not a constant', () => {
  it('the same scenario at floorMs=15min and floorMs=20min yields 15 and 20', () => {
    const scenario = {
      clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 6 * MINUTE }),
      clientSideEverPresent: true,
    };
    const at15 = resolveMeetingSettlement(input({ ...scenario, floorMs: 15 * MINUTE }));
    const at20 = resolveMeetingSettlement(input({ ...scenario, floorMs: 20 * MINUTE }));
    expect(at15.billableMinutes).toBe(15);
    expect(at20.billableMinutes).toBe(20);
  });
});

describe('resolveMeetingSettlement — maxBillableMinutes, the F1 upper bound', () => {
  /** The F1 exploit, exactly: a 30-min call the expert left open for eight hours. */
  const eightHoursHeld = {
    clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 480 * MINUTE }),
    clientSideEverPresent: true,
  };

  it('caps ruleMinutes at maxBillableMinutes and surfaces the uncapped figure', () => {
    const result = resolveMeetingSettlement(input(eightHoursHeld));
    expect(result.shape).toBe('held');
    expect(result.uncappedRuleMinutes).toBe(480);
    expect(result.ruleMinutes).toBe(MAX_BILLABLE_MINUTES);
    expect(result.billableMinutes).toBe(MAX_BILLABLE_MINUTES);
    // `uncappedRuleMinutes > ruleMinutes` ⇔ the cap bound — what the caller log.errors on.
    expect(result.uncappedRuleMinutes).toBeGreaterThan(result.ruleMinutes);
    // `actualMinutes` is NOT capped — it records what presence actually showed.
    expect(result.actualMinutes).toBe(480);
    expect(result.topUpToTickSeq).toBe(MAX_BILLABLE_MINUTES);
  });

  it('does not bind on an ordinary settlement — uncapped and capped agree', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 32 * MINUTE }),
        clientSideEverPresent: true,
      })
    );
    expect(result.uncappedRuleMinutes).toBe(32);
    expect(result.ruleMinutes).toBe(32);
    expect(result.uncappedRuleMinutes).toBe(result.ruleMinutes);
  });

  it('is a PARAMETER, not a constant — the same span caps at whatever the caller injects', () => {
    const at60 = resolveMeetingSettlement(input({ ...eightHoursHeld, maxBillableMinutes: 60 }));
    expect(at60.ruleMinutes).toBe(60);
    expect(at60.uncappedRuleMinutes).toBe(480);
  });

  it('leaves both zero shapes at zero — the cap can only ever lower a figure', () => {
    const result = resolveMeetingSettlement(
      input({ clocks: clocks({ expertFirstJoinedAt: null }), maxBillableMinutes: 0 })
    );
    expect(result.shape).toBe('missed_call');
    expect(result.uncappedRuleMinutes).toBe(0);
    expect(result.ruleMinutes).toBe(0);
  });

  it('CANNOT cap below minutesAlreadyDrawn — the ledger is append-only (no refund)', () => {
    const result = resolveMeetingSettlement(
      input({ ...eightHoursHeld, maxBillableMinutes: 60, minutesAlreadyDrawn: 300 })
    );
    expect(result.ruleMinutes).toBe(60);
    expect(result.billableMinutes).toBe(300); // the no-refund clamp wins over the cap
  });
});

describe('resolveMeetingSettlement — the no-refund clamp (Q1)', () => {
  it('billableMinutes never drops below minutesAlreadyDrawn (held, drawn exceeds the rule figure)', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 6 * MINUTE }),
        clientSideEverPresent: true,
        minutesAlreadyDrawn: 20, // more than both actual (6) and the floor (15)
      })
    );
    expect(result.billableMinutes).toBe(20);
    expect(result.ruleMinutes).toBe(15); // the presence-derived figure BEFORE the clamp
    expect(result.billableMinutes).toBeGreaterThan(result.ruleMinutes); // the clamp fired
    expect(result.topUpFromTickSeq).toBe(21);
    expect(result.topUpToTickSeq).toBe(20); // empty range — no new ticks
    expect(result.topUpToTickSeq).toBeLessThan(result.topUpFromTickSeq);
  });

  it('a zero shape with drawn ticks is clamped up rather than refunded (data-integrity fault surfaced by the caller)', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: null }),
        clientSideEverPresent: false,
        minutesAlreadyDrawn: 4,
      })
    );
    expect(result.shape).toBe('missed_call');
    expect(result.billableMinutes).toBe(4); // clamped up, never refunded
    expect(result.ruleMinutes).toBe(0); // the zero-shape figure — the clamp is the ENTIRE 4
    expect(result.topUpToTickSeq).toBeLessThan(result.topUpFromTickSeq); // still no NEW ticks
  });
});

describe('resolveMeetingSettlement — topUpFrom/To sequencing', () => {
  it('a fresh session (0 drawn) posts ticks 1..billableMinutes', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 6 * MINUTE }),
        clientSideEverPresent: true,
        minutesAlreadyDrawn: 0,
      })
    );
    expect(result.topUpFromTickSeq).toBe(1);
    expect(result.topUpToTickSeq).toBe(15);
  });

  it('a partially-ticked session (4 drawn) tops up 5..billableMinutes', () => {
    const result = resolveMeetingSettlement(
      input({
        clocks: clocks({ expertFirstJoinedAt: SCHEDULED_START, expertPresentMs: 6 * MINUTE }),
        clientSideEverPresent: true,
        minutesAlreadyDrawn: 4,
      })
    );
    expect(result.topUpFromTickSeq).toBe(5);
    expect(result.topUpToTickSeq).toBe(15);
  });
});
