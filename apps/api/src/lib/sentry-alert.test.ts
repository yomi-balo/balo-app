import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCaptureMessage } = vi.hoisted(() => ({ mockCaptureMessage: vi.fn() }));

vi.mock('@sentry/node', () => ({ captureMessage: mockCaptureMessage }));

function fakeLog(): { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), warn: vi.fn() };
}

// ⚠ `vi.resetModules()` + a dynamic import PER TEST — `captureMessageOnce`'s dedup Set is
// module state with no reset export (by design; see `sentry-alert.ts`'s docblock), so a fresh
// module instance is the only way these assertions are independent of test order.
describe('captureMessageOnce (BAL-583)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('captures once per key — a second call with the SAME key is a no-op', async () => {
    const { captureMessageOnce } = await import('./sentry-alert.js');

    captureMessageOnce('k1', 'first message');
    captureMessageOnce('k1', 'first message');

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith('first message', { level: 'error' });
  });

  it('captures again for a DIFFERENT key', async () => {
    const { captureMessageOnce } = await import('./sentry-alert.js');

    captureMessageOnce('k1', 'first message');
    captureMessageOnce('k2', 'second message');

    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });
});

describe('alertMissingConfigAtBoot (BAL-583)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('production: logs error AND captures to Sentry', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { alertMissingConfigAtBoot } = await import('./sentry-alert.js');
    const log = fakeLog();

    alertMissingConfigAtBoot(
      log as unknown as Parameters<typeof alertMissingConfigAtBoot>[0],
      'DAILY_API_KEY is not set'
    );

    expect(log.error).toHaveBeenCalledWith('DAILY_API_KEY is not set');
    expect(log.warn).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith('DAILY_API_KEY is not set', {
      level: 'error',
    });
  });

  it('non-production: warns only — NO Sentry capture', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { alertMissingConfigAtBoot } = await import('./sentry-alert.js');
    const log = fakeLog();

    alertMissingConfigAtBoot(
      log as unknown as Parameters<typeof alertMissingConfigAtBoot>[0],
      'DAILY_API_KEY is not set'
    );

    expect(log.warn).toHaveBeenCalledWith('DAILY_API_KEY is not set');
    expect(log.error).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
