import { describe, it, expect } from 'vitest';
import {
  PRESENCE_SETTLEMENT_GRACE_MINUTES,
  PRESENCE_UNSETTLED_ALERT_MS,
} from './presence-settlement-timing.js';

describe('presence-settlement timings', () => {
  it("the unsettled alert threshold exceeds the backstop's own retry grace", () => {
    expect(PRESENCE_UNSETTLED_ALERT_MS).toBeGreaterThan(PRESENCE_SETTLEMENT_GRACE_MINUTES * 60_000);
  });

  it('pins the shipped values', () => {
    expect(PRESENCE_SETTLEMENT_GRACE_MINUTES).toBe(2);
    expect(PRESENCE_UNSETTLED_ALERT_MS).toBe(30 * 60_000);
  });
});
