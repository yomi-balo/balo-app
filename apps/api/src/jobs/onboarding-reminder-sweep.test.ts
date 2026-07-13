import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const { mockFindIncomplete, mockPublish, mockTrackServer } = vi.hoisted(() => ({
  mockFindIncomplete: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  usersRepository: {
    findIncompleteOnboardingCreatedBetween: mockFindIncomplete,
  },
}));

// `@balo/shared/domains` is pure — use the real classifyEmailDomain (no mock).

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  ONBOARDING_REMINDER_SERVER_EVENTS: {
    SENT: 'onboarding_reminder_sent',
  },
}));

vi.mock('../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock('bullmq', () => ({
  Worker: class MockWorker {},
}));

import {
  runOnboardingReminderSweep,
  ONBOARDING_REMINDER_SWEEP_CRON,
  ONBOARDING_REMINDER_STEPS,
} from './onboarding-reminder-sweep.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A fixed wall-clock so the window math is deterministic.
const NOW = new Date('2026-03-10T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every step's window is empty unless a test overrides it.
  mockFindIncomplete.mockResolvedValue([]);
});

describe('runOnboardingReminderSweep — window math', () => {
  it('queries the three half-open (after, until] bands: [24h,25h), [72h,73h), [168h,169h)', async () => {
    await runOnboardingReminderSweep(NOW);

    expect(mockFindIncomplete).toHaveBeenCalledTimes(3);

    // Step 1: age ∈ [24h, 25h)
    expect(mockFindIncomplete.mock.calls[0]?.[0]).toEqual(new Date(NOW.getTime() - 25 * HOUR_MS));
    expect(mockFindIncomplete.mock.calls[0]?.[1]).toEqual(new Date(NOW.getTime() - 24 * HOUR_MS));
    // Step 2: age ∈ [72h, 73h)
    expect(mockFindIncomplete.mock.calls[1]?.[0]).toEqual(new Date(NOW.getTime() - 73 * HOUR_MS));
    expect(mockFindIncomplete.mock.calls[1]?.[1]).toEqual(new Date(NOW.getTime() - 72 * HOUR_MS));
    // Step 3: age ∈ [168h, 169h)  (7 days)
    expect(mockFindIncomplete.mock.calls[2]?.[0]).toEqual(
      new Date(NOW.getTime() - 7 * DAY_MS - HOUR_MS)
    );
    expect(mockFindIncomplete.mock.calls[2]?.[1]).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
  });
});

describe('runOnboardingReminderSweep — publish + analytics', () => {
  it('publishes onboarding.reminder with the (user, step) correlationId + cadenceStep', async () => {
    // Step 1 has one corporate-domain user; steps 2 + 3 are empty.
    mockFindIncomplete
      .mockResolvedValueOnce([{ id: 'user-1', email: 'founder@acme.com' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await runOnboardingReminderSweep(NOW);

    expect(result).toEqual({ sent: 1 });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('onboarding.reminder', {
      correlationId: 'user-1:onboarding_reminder:1',
      userId: 'user-1',
      cadenceStep: 1,
    });
  });

  it('tags _sent with cadence_step, the recomputed domain_class, and distinct_id = userId', async () => {
    // corporate at step 1, freemail at step 2.
    mockFindIncomplete
      .mockResolvedValueOnce([{ id: 'corp-1', email: 'a@acme.com' }])
      .mockResolvedValueOnce([{ id: 'free-1', email: 'b@gmail.com' }])
      .mockResolvedValueOnce([]);

    await runOnboardingReminderSweep(NOW);

    expect(mockTrackServer).toHaveBeenCalledWith('onboarding_reminder_sent', {
      cadence_step: 1,
      domain_class: 'corporate',
      distinct_id: 'corp-1',
    });
    expect(mockTrackServer).toHaveBeenCalledWith('onboarding_reminder_sent', {
      cadence_step: 2,
      domain_class: 'freemail',
      distinct_id: 'free-1',
    });
  });

  it('uses the step index in the correlationId for each cadence band', async () => {
    mockFindIncomplete
      .mockResolvedValueOnce([{ id: 'u1', email: 'a@acme.com' }])
      .mockResolvedValueOnce([{ id: 'u2', email: 'b@acme.com' }])
      .mockResolvedValueOnce([{ id: 'u3', email: 'c@acme.com' }]);

    const result = await runOnboardingReminderSweep(NOW);

    expect(result).toEqual({ sent: 3 });
    expect(mockPublish).toHaveBeenNthCalledWith(
      1,
      'onboarding.reminder',
      expect.objectContaining({ correlationId: 'u1:onboarding_reminder:1', cadenceStep: 1 })
    );
    expect(mockPublish).toHaveBeenNthCalledWith(
      2,
      'onboarding.reminder',
      expect.objectContaining({ correlationId: 'u2:onboarding_reminder:2', cadenceStep: 2 })
    );
    expect(mockPublish).toHaveBeenNthCalledWith(
      3,
      'onboarding.reminder',
      expect.objectContaining({ correlationId: 'u3:onboarding_reminder:3', cadenceStep: 3 })
    );
  });
});

describe('runOnboardingReminderSweep — per-row isolation', () => {
  it('one failed publish does not abort the batch; only successes are counted', async () => {
    mockFindIncomplete
      .mockResolvedValueOnce([
        { id: 'bad', email: 'bad@acme.com' },
        { id: 'good', email: 'good@acme.com' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockPublish.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    const result = await runOnboardingReminderSweep(NOW);

    expect(result).toEqual({ sent: 1 }); // only the good row counted
    // _sent fires only for the row whose publish resolved.
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'onboarding_reminder_sent',
      expect.objectContaining({ distinct_id: 'good' })
    );
  });
});

describe('config knobs', () => {
  it('exposes the hourly cron cadence and the three cadence steps', () => {
    expect(ONBOARDING_REMINDER_SWEEP_CRON).toBe('0 * * * *');
    expect(ONBOARDING_REMINDER_STEPS.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(ONBOARDING_REMINDER_STEPS.map((s) => s.ageMs)).toEqual([
      24 * HOUR_MS,
      72 * HOUR_MS,
      7 * DAY_MS,
    ]);
  });
});
