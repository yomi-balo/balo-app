import { describe, it, expect } from 'vitest';
import {
  deriveDrawdownState,
  derivePromoRemainingMinor,
  type DrawdownInputs,
  type DrawdownKey,
} from './drawdown-state';

const NOW = new Date('2026-07-16T12:00:00.000Z');
const RATE = 100; // A$1.00/min

function base(overrides: Partial<DrawdownInputs> = {}): DrawdownInputs {
  return {
    status: 'active',
    connectedAt: new Date(NOW.getTime() - 42 * 60_000), // 42 min in
    clientRateMinorPerMinute: RATE,
    effectiveCeilingMinor: 15_000,
    graceBoundMinutes: 30,
    graceEnteredAt: null,
    balanceMinor: 50_000, // ~500 min runway
    // BAL-412 (D6) — 42 minutes already drawn is well past the 15-minute floor, so the
    // corrected runway formula reduces EXACTLY to the shipped `floor(balance/rate)` for every
    // existing scenario below. This is what keeps "past minute 15 is byte-identical" true.
    billingFloorMinutes: 15,
    minutesAlreadyDrawn: 42,
    mandatePresent: true,
    lens: 'client',
    now: NOW,
    ...overrides,
  };
}

/** Inputs shaped to land on each of the six keys. */
const KEY_INPUTS: Record<DrawdownKey, Partial<DrawdownInputs>> = {
  healthy: { status: 'active', balanceMinor: 50_000 },
  low: { status: 'active', balanceMinor: 500 }, // 5 min ≤ 8
  grace: {
    status: 'grace',
    balanceMinor: -2_000,
    graceEnteredAt: new Date(NOW.getTime() - 5 * 60_000),
  },
  near: {
    status: 'grace',
    balanceMinor: -2_000,
    graceEnteredAt: new Date(NOW.getTime() - 25 * 60_000),
  },
  wrap: {
    status: 'wrapped',
    balanceMinor: -15_000,
    graceEnteredAt: new Date(NOW.getTime() - 30 * 60_000),
  },
  end: { status: 'wrapped', balanceMinor: 0, graceEnteredAt: null },
};

describe('deriveDrawdownState — key derivation', () => {
  for (const key of Object.keys(KEY_INPUTS) as DrawdownKey[]) {
    it(`derives '${key}' for its shaped inputs (client lens)`, () => {
      const state = deriveDrawdownState(base({ ...KEY_INPUTS[key], lens: 'client' }));
      expect(state.key).toBe(key);
    });
    it(`derives '${key}' for its shaped inputs (member lens)`, () => {
      const state = deriveDrawdownState(base({ ...KEY_INPUTS[key], lens: 'member' }));
      expect(state.key).toBe(key);
    });
  }
});

describe('deriveDrawdownState — elapsed is session time, never a countdown', () => {
  it('formats HH:MM:SS from connectedAt', () => {
    const state = deriveDrawdownState(
      base({ connectedAt: new Date(NOW.getTime() - (3_600 + 125) * 1000) })
    );
    expect(state.elapsed).toBe('01:02:05');
  });

  it('reads 00:00:00 with a null connect anchor', () => {
    const state = deriveDrawdownState(base({ status: 'pending', connectedAt: null }));
    expect(state.elapsed).toBe('00:00:00');
  });

  it('never surfaces minutesRemaining when healthy', () => {
    const state = deriveDrawdownState(base({ status: 'active', balanceMinor: 50_000 }));
    expect(state.key).toBe('healthy');
    expect(state.minutesRemaining).toBeUndefined();
  });
});

describe('deriveDrawdownState — client lens copy', () => {
  it('low (mandate) offers Top up + Keep going', () => {
    const state = deriveDrawdownState(
      base({ ...KEY_INPUTS.low, lens: 'client', mandatePresent: true })
    );
    expect(state.title).toBe('About 5 minutes of balance left');
    expect(state.cta).toEqual({
      kind: 'client_topup',
      label: 'Top up',
      secondaryLabel: 'Keep going',
    });
    expect(state.minutesRemaining).toBe(5);
    expect(state.channels).toEqual(['in-app']);
  });

  it('low (no mandate) drops the Keep going secondary', () => {
    const state = deriveDrawdownState(
      base({ ...KEY_INPUTS.low, lens: 'client', mandatePresent: false })
    );
    expect(state.cta).toEqual({ kind: 'client_topup', label: 'Top up' });
    expect(state.body).toContain('near the end of your balance');
  });

  it('grace leads with reassurance + settles-afterward, SMS present', () => {
    const state = deriveDrawdownState(base({ ...KEY_INPUTS.grace, lens: 'client' }));
    expect(state.title).toBe("We're keeping you going");
    expect(state.tone).toBe('keep');
    expect(state.channels).toEqual(['in-app', 'sms']);
    expect(state.sms).toContain('settles to your card afterward');
    expect(state.ceilingRoomMinor).toBe(13_000);
  });

  it('near is amber with a wrap CTA + SMS', () => {
    const state = deriveDrawdownState(base({ ...KEY_INPUTS.near, lens: 'client' }));
    expect(state.title).toBe('Coming up on a good place to wrap');
    expect(state.cta?.label).toBe('Top up to keep going');
    expect(state.channels).toEqual(['in-app', 'sms']);
    expect(state.graceRemainingMinutes).toBe(5);
  });

  it('wrap is a warm pause (paused, in-app only)', () => {
    const state = deriveDrawdownState(base({ ...KEY_INPUTS.wrap, lens: 'client' }));
    expect(state.paused).toBe(true);
    expect(state.title).toBe("Let's pause here for now");
    expect(state.channels).toEqual(['in-app']);
    expect(state.meter.pct).toBe(100);
  });

  it('end (no card) is the balance-used pause', () => {
    const state = deriveDrawdownState(
      base({ ...KEY_INPUTS.end, lens: 'client', mandatePresent: false })
    );
    expect(state.title).toBe("You're at the end of your balance");
    expect(state.meter).toMatchObject({ mode: 'empty', pct: 0, tone: 'faint' });
  });
});

describe('deriveDrawdownState — member lens copy', () => {
  it('low nudges the admin (team-framed, no top-up button)', () => {
    const state = deriveDrawdownState(
      base({ ...KEY_INPUTS.low, lens: 'member', adminName: 'Sam' })
    );
    expect(state.title).toBe("Your team's balance is running low");
    expect(state.cta).toEqual({ kind: 'member_nudge', label: 'Let Sam know' });
    expect(state.adminName).toBe('Sam');
  });

  it('falls back to "your admin" when no adminName is provided', () => {
    const state = deriveDrawdownState(base({ ...KEY_INPUTS.near, lens: 'member' }));
    expect(state.cta?.label).toBe('Ask your admin to top up');
    expect(state.adminName).toBeUndefined();
  });

  it('grace protects the member on the company mandate (no nudge, SMS present)', () => {
    const state = deriveDrawdownState(base({ ...KEY_INPUTS.grace, lens: 'member' }));
    expect(state.title).toBe("We're keeping you going");
    expect(state.cta).toBeUndefined();
    expect(state.meter.label).toBe('Keeping you going');
    expect(state.sms).toContain('team card');
  });

  it('healthy meter is team-framed', () => {
    const state = deriveDrawdownState(
      base({ status: 'active', balanceMinor: 50_000, lens: 'member' })
    );
    expect(state.meter.label).toBe('Team balance healthy');
  });
});

describe('deriveDrawdownState — promo chip', () => {
  it('carries promoRemainingMinor onto the state when provided', () => {
    const state = deriveDrawdownState(base({ promoRemainingMinor: 2_500 }));
    expect(state.promoRemainingMinor).toBe(2_500);
  });

  it('omits promoRemainingMinor when absent', () => {
    const state = deriveDrawdownState(base());
    expect(state.promoRemainingMinor).toBeUndefined();
  });
});

describe('deriveDrawdownState — the word "overdraft" never appears', () => {
  it('is absent from every client + member string across all keys', () => {
    const strings: string[] = [];
    for (const key of Object.keys(KEY_INPUTS) as DrawdownKey[]) {
      for (const lens of ['client', 'member'] as const) {
        for (const mandatePresent of [true, false]) {
          const state = deriveDrawdownState(
            base({ ...KEY_INPUTS[key], lens, mandatePresent, adminName: 'Sam' })
          );
          strings.push(
            state.title ?? '',
            state.body ?? '',
            state.sms ?? '',
            state.meter.label,
            state.cta?.label ?? '',
            state.cta?.secondaryLabel ?? ''
          );
        }
      }
    }
    for (const value of strings) {
      expect(value.toLowerCase()).not.toContain('overdraft');
    }
  });
});

/**
 * BAL-412 (ADR-1044 §7, D6) — the runway correction's effect on `deriveDrawdownState`.
 * `runway.test.ts` pins the pure formula directly; these pin its INTEGRATION into the
 * presentational key + copy, which is the surface a client actually sees.
 */
describe('deriveDrawdownState — the runway correction (BAL-412, D6)', () => {
  it('a scenario that was `healthy` under the old formula is `low` under the corrected one', () => {
    // floor(2000/100) = 20 (the OLD, uncorrected answer) ⇒ would have been `healthy`.
    // Corrected: unconsumed floor = 15 − 2 = 13 min ⇒ committed = 1300 ⇒ discretionary = 700
    // ⇒ 7 min, which is ≤ LOW_BALANCE_WARNING_MINUTES (8) ⇒ `low`. The warning fires SOONER,
    // which is the intended effect (never later — it is the conservative direction).
    const state = deriveDrawdownState(
      base({
        status: 'active',
        balanceMinor: 2_000,
        billingFloorMinutes: 15,
        minutesAlreadyDrawn: 2,
      })
    );
    expect(state.key).toBe('low');
    expect(state.minutesRemaining).toBe(7);
    expect(state.title).toBe('About 7 minutes of balance left');
  });

  it('early in a session (floor mostly unconsumed) reports the corrected discretionary figure', () => {
    // The ticket's own worked example: rate=100, floor=15, drawn=2, balance=3000 → 17 (not 30).
    const state = deriveDrawdownState(
      base({
        status: 'active',
        balanceMinor: 900, // low enough to surface `minutesRemaining` (key = 'low')
        billingFloorMinutes: 15,
        minutesAlreadyDrawn: 2,
      })
    );
    // unconsumed = 13, committed = 1300 > 900 ⇒ discretionary ≤ 0 ⇒ 0 minutes remaining, `low`.
    expect(state.key).toBe('low');
    expect(state.minutesRemaining).toBe(0);
  });

  it('floor fully consumed (drawn ≥ floor) is byte-identical to the shipped healthy/low boundary', () => {
    // At drawn=15 (== floor), the correction is a no-op: unconsumed=0, so this is exactly
    // floor(balance/rate). Same assertions as the un-corrected KEY_INPUTS.low scenario.
    const state = deriveDrawdownState(
      base({
        status: 'active',
        balanceMinor: 500,
        billingFloorMinutes: 15,
        minutesAlreadyDrawn: 15,
      })
    );
    expect(state.key).toBe('low');
    expect(state.minutesRemaining).toBe(5);
  });

  it('grace/near/wrap/end keys are unaffected by the floor (they do not read minutesRemaining)', () => {
    for (const key of ['grace', 'near', 'wrap', 'end'] as const) {
      const withFloor = deriveDrawdownState(
        base({ ...KEY_INPUTS[key], billingFloorMinutes: 15, minutesAlreadyDrawn: 2 })
      );
      const pastFloor = deriveDrawdownState(
        base({ ...KEY_INPUTS[key], billingFloorMinutes: 15, minutesAlreadyDrawn: 42 })
      );
      expect(withFloor.key).toBe(pastFloor.key);
      expect(withFloor.graceRemainingMinutes).toBe(pastFloor.graceRemainingMinutes);
      expect(withFloor.ceilingRoomMinor).toBe(pastFloor.ceilingRoomMinor);
    }
  });
});

describe('derivePromoRemainingMinor', () => {
  it('is granted minus consumed, clamped to the balance', () => {
    expect(
      derivePromoRemainingMinor({
        promoGrantedMinor: 5_000,
        consumedSincePromoMinor: 1_500,
        currentBalanceMinor: 10_000,
      })
    ).toBe(3_500);
  });

  it('clamps to the current balance when the balance is the tighter bound', () => {
    expect(
      derivePromoRemainingMinor({
        promoGrantedMinor: 5_000,
        consumedSincePromoMinor: 0,
        currentBalanceMinor: 2_000,
      })
    ).toBe(2_000);
  });

  it('never goes negative when consumption exceeds the grant', () => {
    expect(
      derivePromoRemainingMinor({
        promoGrantedMinor: 5_000,
        consumedSincePromoMinor: 9_000,
        currentBalanceMinor: 1_000,
      })
    ).toBe(0);
  });

  it('is zero when the balance is negative (in grace)', () => {
    expect(
      derivePromoRemainingMinor({
        promoGrantedMinor: 5_000,
        consumedSincePromoMinor: 0,
        currentBalanceMinor: -2_000,
      })
    ).toBe(0);
  });
});
