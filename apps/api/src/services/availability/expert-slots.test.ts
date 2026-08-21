import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AVAILABILITY_LEAD_GUARD_MINUTES, SLOT_STEP_MINUTES } from '@balo/shared/availability';

const { mockFindResolverSettings, mockListRules, mockListConfirmedInRange, mockListUpcoming } =
  vi.hoisted(() => ({
    mockFindResolverSettings: vi.fn(),
    mockListRules: vi.fn(),
    mockListConfirmedInRange: vi.fn(),
    mockListUpcoming: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  expertsRepository: { findResolverSettings: mockFindResolverSettings },
  availabilityRulesRepository: { listByExpertProfileId: mockListRules },
  consultationsRepository: { listConfirmedInRange: mockListConfirmedInRange },
  availabilityOverridesRepository: { listUpcoming: mockListUpcoming },
}));

import { computeExpertSlots } from './expert-slots.js';
import { vendorBusyProvider, VendorBusyUnavailableError } from './vendor-busy.js';

const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-07T00:00:00.000Z'); // Monday

const MONDAY_NINE_TO_FIVE = [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }];
const DEFAULT_SETTINGS = {
  timezone: 'UTC',
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindResolverSettings.mockResolvedValue(DEFAULT_SETTINGS);
  mockListRules.mockResolvedValue(MONDAY_NINE_TO_FIVE);
  mockListConfirmedInRange.mockResolvedValue([]);
  mockListUpcoming.mockResolvedValue([]);
  vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockResolvedValue([]);
});

describe('computeExpertSlots — status ladder', () => {
  it('expert_not_found when resolver settings are missing', async () => {
    mockFindResolverSettings.mockResolvedValue(null);
    const result = await computeExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('expert_not_found');
    expect(result.slots).toEqual([]);
  });

  it('not_configured wins over a vendor failure — checked BEFORE the vendor outcome (D8)', async () => {
    mockListRules.mockResolvedValue([]);
    vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockRejectedValue(
      new VendorBusyUnavailableError(EXPERT_PROFILE_ID, 'unreadable connection')
    );
    const result = await computeExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('not_configured');
    expect(result.slots).toEqual([]);
  });

  it('VendorBusyUnavailableError -> unavailable', async () => {
    vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockRejectedValue(
      new VendorBusyUnavailableError(EXPERT_PROFILE_ID, 'unreadable connection')
    );
    const result = await computeExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('unavailable');
    expect(result.slots).toEqual([]);
  });

  it('any other vendor error rethrows', async () => {
    vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockRejectedValue(new Error('db down'));
    await expect(computeExpertSlots(EXPERT_PROFILE_ID, NOW)).rejects.toThrow('db down');
  });

  it('empty grid -> no_slots', async () => {
    // Rules exist but every minute is consumed by a confirmed consultation.
    mockListConfirmedInRange.mockResolvedValue([
      { startAt: new Date('2026-09-07T00:00:00Z'), endAt: new Date('2026-11-30T00:00:00Z') },
    ]);
    const result = await computeExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('no_slots');
    expect(result.slots).toEqual([]);
  });

  it('happy path -> ok with the expert timezone', async () => {
    const result = await computeExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('ok');
    expect(result.expertTimezone).toBe('UTC');
    expect(result.slots.length).toBeGreaterThan(0);
  });
});

/**
 * ⚠ THE SEAM, NOT THE CONSTANT. `packages/shared` pins that
 * `AVAILABILITY_LEAD_GUARD_MINUTES` is large enough, and `slot-grid-accepts.test.ts` pins that
 * the grid survives cache staleness — but every case above uses `minimumNoticeMinutes: 0` with
 * `NOW` far below the rules' first hour, so DELETING the `leadGuardMinutes:` line from
 * `computeExpertSlots`'s `listBookableSlots(…)` call left all six of them green. The whole
 * guard was unthreaded and nothing noticed. This case is the one that fails when it is.
 */
describe('computeExpertSlots — the lead guard is threaded into the grid', () => {
  const NOTICE_MINUTES = 600; // pushes the first slot past the rules' 09:00 edge

  it('the first slot sits at now + notice + AVAILABILITY_LEAD_GUARD_MINUTES, rounded up to the step', async () => {
    mockFindResolverSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      minimumNoticeMinutes: NOTICE_MINUTES,
    });

    const stepMs = SLOT_STEP_MINUTES * 60_000;
    const ceilToStep = (ms: number): number => Math.ceil(ms / stepMs) * stepMs;
    const withGuard = ceilToStep(
      NOW.getTime() + (NOTICE_MINUTES + AVAILABILITY_LEAD_GUARD_MINUTES) * 60_000
    );
    const withoutGuard = ceilToStep(NOW.getTime() + NOTICE_MINUTES * 60_000);

    // The assertion below is only meaningful if the two differ — i.e. if the guard actually
    // pushes across a step boundary. Pinned so a future notice/step/guard edit cannot quietly
    // make this test vacuous again.
    expect(withGuard).not.toBe(withoutGuard);

    const result = await computeExpertSlots(EXPERT_PROFILE_ID, NOW);
    const [first] = result.slots;
    expect(first).toBeDefined();
    expect(first?.startAt.toISOString()).toBe(new Date(withGuard).toISOString());
  });
});
