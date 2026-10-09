import { describe, it, expect } from 'vitest';
import { isReapplyCooldownActive, reapplyAvailableAt } from './reapply-cooldown';

const DECIDED_AT = new Date('2026-10-01T15:00:00.000Z');
const UTC_PLUS_14_OFFSET_MS = 14 * 60 * 60 * 1000;

describe('reapplyAvailableAt', () => {
  it('shows the UTC calendar date of the decision instant plus whole days, at 00:00Z', () => {
    expect(reapplyAvailableAt(DECIDED_AT, 60)).toEqual(new Date('2026-11-30T00:00:00.000Z'));
  });

  it('returns the decision instant`s calendar date at 00:00Z for a zero-day cooldown', () => {
    expect(reapplyAvailableAt(DECIDED_AT, 0)).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('returns null when there is no decision timestamp', () => {
    expect(reapplyAvailableAt(null, 60)).toBeNull();
  });
});

describe('isReapplyCooldownActive', () => {
  const availableAt = new Date('2026-11-30T00:00:00.000Z');
  const gateOpensAt = new Date(availableAt.getTime() - UTC_PLUS_14_OFFSET_MS);

  it('is active one millisecond before the 14h-early gate opens', () => {
    expect(isReapplyCooldownActive(DECIDED_AT, 60, new Date(gateOpensAt.getTime() - 1))).toBe(true);
  });

  it('is not active at the instant the 14h-early gate opens', () => {
    expect(isReapplyCooldownActive(DECIDED_AT, 60, gateOpensAt)).toBe(false);
  });

  it('is not active for a zero-day cooldown', () => {
    expect(isReapplyCooldownActive(DECIDED_AT, 0, DECIDED_AT)).toBe(false);
  });

  it('is never active without a decision timestamp', () => {
    expect(isReapplyCooldownActive(null, 60, DECIDED_AT)).toBe(false);
  });
});
