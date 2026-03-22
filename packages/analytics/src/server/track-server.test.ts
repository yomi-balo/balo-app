import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCapture = vi.fn();
const mockShutdown = vi.fn();

vi.mock('posthog-node', () => ({
  PostHog: class MockPostHog {
    capture = mockCapture;
    shutdown = mockShutdown;
  },
}));

describe('shutdownServerAnalytics', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    mockCapture.mockClear();
    mockShutdown.mockClear();
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

describe('trackServer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    mockCapture.mockClear();
    mockShutdown.mockClear();
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
});
