import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCapture = vi.fn();
const mockShutdown = vi.fn();
const mockFlush = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('posthog-node', () => ({
  PostHog: class MockPostHog {
    capture = mockCapture;
    shutdown = mockShutdown;
    flush = mockFlush;
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ error: mockLoggerError }),
}));

describe('shutdownServerAnalytics', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    mockCapture.mockClear();
    mockShutdown.mockClear();
    mockFlush.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('flushes and nulls the singleton when an instance exists', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test_key';

    const { getServerAnalytics, shutdownServerAnalytics } = await import('./posthog-server');

    // Initialize the singleton
    getServerAnalytics();

    await shutdownServerAnalytics();

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it('is a no-op when no instance exists', async () => {
    delete process.env.POSTHOG_API_KEY;

    const { shutdownServerAnalytics } = await import('./posthog-server');

    await shutdownServerAnalytics();

    expect(mockShutdown).not.toHaveBeenCalled();
  });
});

describe('flushServerAnalytics', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    mockCapture.mockClear();
    mockShutdown.mockClear();
    mockFlush.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('flushes the singleton WITHOUT closing it when an instance exists', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test_key';

    const { getServerAnalytics, flushServerAnalytics } = await import('./posthog-server');

    // Initialize the singleton
    getServerAnalytics();

    await flushServerAnalytics();

    expect(mockFlush).toHaveBeenCalledOnce();
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it('is a no-op when no instance exists', async () => {
    delete process.env.POSTHOG_API_KEY;

    const { flushServerAnalytics } = await import('./posthog-server');

    await flushServerAnalytics();

    expect(mockFlush).not.toHaveBeenCalled();
  });
});

describe('trackServer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    mockCapture.mockClear();
    mockShutdown.mockClear();
    mockFlush.mockClear();
    mockLoggerError.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('is a no-op when POSTHOG_API_KEY is not set', async () => {
    delete process.env.POSTHOG_API_KEY;

    const { trackServer } = await import('./track-server');
    const { EXPERT_PAYOUT_SERVER_EVENTS } = await import('../events/expert-payouts');

    trackServer(EXPERT_PAYOUT_SERVER_EVENTS.AIRWALLEX_BENEFICIARY_REGISTERED, {
      method: 'LOCAL',
      country_code: 'AU',
      beneficiary_status: 'verified',
      distinct_id: 'user-123',
    });

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('calls PostHog.capture with correct distinctId, event, and properties when API key is set', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test_key';
    process.env.POSTHOG_HOST = 'https://posthog.example.com';

    const { trackServer } = await import('./track-server');
    const { EXPERT_PAYOUT_SERVER_EVENTS } = await import('../events/expert-payouts');

    trackServer(EXPERT_PAYOUT_SERVER_EVENTS.AIRWALLEX_BENEFICIARY_REGISTERED, {
      method: 'LOCAL',
      country_code: 'AU',
      beneficiary_status: 'verified',
      distinct_id: 'user-456',
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-456',
      event: 'expert_airwallex_beneficiary_registered',
      properties: {
        method: 'LOCAL',
        country_code: 'AU',
        beneficiary_status: 'verified',
      },
    });
  });

  it("a throwing client.capture does not escape trackServer, and the failure is logged under Pino's err key", async () => {
    process.env.POSTHOG_API_KEY = 'phc_test_key';
    const thrown = new Error('posthog is down');
    mockCapture.mockImplementationOnce(() => {
      throw thrown;
    });

    const { trackServer } = await import('./track-server');
    const { EXPERT_PAYOUT_SERVER_EVENTS } = await import('../events/expert-payouts');

    expect(() =>
      trackServer(EXPERT_PAYOUT_SERVER_EVENTS.AIRWALLEX_BENEFICIARY_REGISTERED, {
        method: 'LOCAL',
        country_code: 'AU',
        beneficiary_status: 'verified',
        distinct_id: 'user-789',
      })
    ).not.toThrow();

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [payload, message] = mockLoggerError.mock.calls[0] as [
      { event: string; err: unknown },
      string,
    ];
    expect(payload.event).toBe('expert_airwallex_beneficiary_registered');
    // FIX ROUND 3 R5 — logged under Pino's `err` key (its default `pino-std-serializers` err
    // serializer attaches type/message/stack), not flattened to a bare `error: error.message`
    // string.
    expect(payload.err).toBe(thrown);
    expect(payload).not.toHaveProperty('error');
    // ⚠ event PROPERTIES never appear in the log line — the payload can carry PII.
    expect(payload).not.toHaveProperty('properties');
    expect(payload).not.toHaveProperty('country_code');
    expect(message).toBe('PostHog capture failed');
  });
});
