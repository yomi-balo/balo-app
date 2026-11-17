import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

import { CALL_NOW_RING_MS, CALL_NOW_RING_SMS_MS } from '@balo/shared/meetings';
import { resolveCallNowRingWindows, ringExpiresAt } from './call-now-timers.js';

const VARIABLES = ['CALL_NOW_RING_SECONDS', 'CALL_NOW_RING_SMS_SECONDS'] as const;

describe('resolveCallNowRingWindows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const variable of VARIABLES) vi.stubEnv(variable, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers the shipped defaults when nothing is set', () => {
    expect(resolveCallNowRingWindows()).toEqual({
      appMs: CALL_NOW_RING_MS,
      smsMs: CALL_NOW_RING_SMS_MS,
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('applies each override independently, in whole seconds', () => {
    vi.stubEnv('CALL_NOW_RING_SECONDS', '30');
    expect(resolveCallNowRingWindows()).toEqual({ appMs: 30_000, smsMs: CALL_NOW_RING_SMS_MS });

    vi.stubEnv('CALL_NOW_RING_SMS_SECONDS', ' 90 ');
    expect(resolveCallNowRingWindows()).toEqual({ appMs: 30_000, smsMs: 90_000 });
  });

  it.each(['0', '-5', '4.5', 'abc', '1e3', '99999999'])(
    'warns about and ignores the invalid value %s',
    (raw) => {
      vi.stubEnv('CALL_NOW_RING_SECONDS', raw);

      expect(resolveCallNowRingWindows().appMs).toBe(CALL_NOW_RING_MS);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ variable: 'CALL_NOW_RING_SECONDS' }),
        expect.stringContaining('positive whole number of seconds')
      );
    }
  );
});

describe('ringExpiresAt', () => {
  const NOW = new Date('2026-11-16T10:00:00.000Z');
  const WINDOWS = { appMs: 45_000, smsMs: 120_000 };

  it('adds the app window for an app-reached ring', () => {
    expect(ringExpiresAt(NOW, 'app', WINDOWS).toISOString()).toBe('2026-11-16T10:00:45.000Z');
  });

  it('adds the SMS window for an SMS-reached ring', () => {
    expect(ringExpiresAt(NOW, 'sms', WINDOWS).toISOString()).toBe('2026-11-16T10:02:00.000Z');
  });
});
