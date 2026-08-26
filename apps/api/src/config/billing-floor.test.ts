import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarn, mockError, mockInfo } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: mockError }),
}));

import { MAX_MEETING_MINUTES } from '@balo/shared/meetings';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';
import {
  assertNoShowFloorOverrideUnsetInProduction,
  resolveBillingFloorMinutes,
  resolveBillingFloorMs,
  resolveMaxBillableMinutes,
} from './billing-floor.js';

const VARIABLE = 'MEETING_NO_SHOW_FLOOR_MINUTES';

function clear(): void {
  delete process.env[VARIABLE];
}

describe('resolveBillingFloorMinutes / resolveBillingFloorMs (BAL-412, D5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clear();
  });
  afterEach(clear);

  it('defaults to 15 minutes / 900_000ms', () => {
    expect(resolveBillingFloorMinutes()).toBe(15);
    expect(resolveBillingFloorMs()).toBe(15 * 60_000);
  });

  it('MEETING_NO_SHOW_FLOOR_MINUTES=20 → 20 minutes', () => {
    process.env[VARIABLE] = '20';
    expect(resolveBillingFloorMinutes()).toBe(20);
    expect(resolveBillingFloorMs()).toBe(20 * 60_000);
  });

  it('a malformed override falls back to the default and logs at warn (via resolveMeetingTimers)', () => {
    process.env[VARIABLE] = 'not-a-number';
    expect(resolveBillingFloorMinutes()).toBe(15);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('is read at CALL TIME, not import time — a later env write is observed', () => {
    expect(resolveBillingFloorMinutes()).toBe(15);
    process.env[VARIABLE] = '30';
    expect(resolveBillingFloorMinutes()).toBe(30);
  });

  it('⚠⚠ F5 — an override ABOVE MAX_MEETING_MINUTES is discarded, not clamped, and logs at error', () => {
    // The reported footgun: an operator sets 900 thinking SECONDS. Unbounded, every no-show
    // would settle at 900 minutes, charged off-session against the stored mandate.
    process.env[VARIABLE] = '900';
    expect(resolveBillingFloorMinutes()).toBe(15); // the shipped default, NOT 900 and NOT 480
    expect(resolveBillingFloorMs()).toBe(15 * 60_000);
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({
        variable: VARIABLE,
        resolvedMinutes: 900,
        maxMinutes: MAX_MEETING_MINUTES,
        fallbackMinutes: 15,
      }),
      expect.stringContaining('exceeds MAX_MEETING_MINUTES')
    );
  });

  it('F5 — a value exactly AT MAX_MEETING_MINUTES is accepted (the bound is inclusive)', () => {
    process.env[VARIABLE] = String(MAX_MEETING_MINUTES);
    expect(resolveBillingFloorMinutes()).toBe(MAX_MEETING_MINUTES);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('F5 — one minute above the bound is refused', () => {
    process.env[VARIABLE] = String(MAX_MEETING_MINUTES + 1);
    expect(resolveBillingFloorMinutes()).toBe(15);
    expect(mockError).toHaveBeenCalled();
  });

  it('F5 — an in-range override is untouched and logs no error', () => {
    process.env[VARIABLE] = '30';
    expect(resolveBillingFloorMinutes()).toBe(30);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('F1 — resolveMaxBillableMinutes restates MAX_SESSION_MINUTES and is NOT env-overridable', () => {
    expect(resolveMaxBillableMinutes()).toBe(MAX_SESSION_MINUTES);
    process.env[VARIABLE] = '900';
    // The settlement ceiling is independent of the floor override entirely.
    expect(resolveMaxBillableMinutes()).toBe(MAX_SESSION_MINUTES);
  });

  it('F1 — the settlement ceiling is NOT MAX_MEETING_MINUTES (bounds.ts: "do not unify them")', () => {
    expect(resolveMaxBillableMinutes()).not.toBe(MAX_MEETING_MINUTES);
    expect(resolveMaxBillableMinutes()).toBeLessThan(MAX_MEETING_MINUTES);
  });

  it('is ONE seam — it derives from resolveMeetingTimers().noShowFloorMs, never a second constant', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./billing-floor.ts', import.meta.url), 'utf8')
    );
    expect(source).toContain('resolveMeetingTimers().noShowFloorMs');
  });
});

describe('assertNoShowFloorOverrideUnsetInProduction (BAL-466, D13)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    clear();
  });
  afterEach(() => {
    clear();
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('throws when NODE_ENV=production and the override is set', () => {
    process.env.NODE_ENV = 'production';
    process.env[VARIABLE] = '15';
    expect(() => assertNoShowFloorOverrideUnsetInProduction()).toThrow(
      /must not be set in production/
    );
  });

  it('does not throw in production when the override is unset', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertNoShowFloorOverrideUnsetInProduction()).not.toThrow();
  });

  it('does not throw outside production, even with the override set', () => {
    process.env.NODE_ENV = 'test';
    process.env[VARIABLE] = '15';
    expect(() => assertNoShowFloorOverrideUnsetInProduction()).not.toThrow();
  });

  it('does not throw in development with the override set', () => {
    process.env.NODE_ENV = 'development';
    process.env[VARIABLE] = '15';
    expect(() => assertNoShowFloorOverrideUnsetInProduction()).not.toThrow();
  });

  it('F2 — does not throw in production when the override is a BLANK STRING (Railway writes empty for unset)', () => {
    process.env.NODE_ENV = 'production';
    process.env[VARIABLE] = '';
    expect(() => assertNoShowFloorOverrideUnsetInProduction()).not.toThrow();
  });
});
