import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockFindTimezone,
  mockListRules,
  mockListConsultations,
  mockUpsertCache,
  mockResolve,
  mockWarn,
  mockInfo,
} = vi.hoisted(() => ({
  mockFindTimezone: vi.fn(),
  mockListRules: vi.fn(),
  mockListConsultations: vi.fn(),
  mockUpsertCache: vi.fn(),
  mockResolve: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findTimezone: mockFindTimezone },
  availabilityRulesRepository: { listByExpertProfileId: mockListRules },
  consultationsRepository: { listConfirmedInRange: mockListConsultations },
  calendarRepository: { upsertAvailabilityCache: mockUpsertCache },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockInfo,
    warn: mockWarn,
    error: vi.fn(),
  }),
}));

vi.mock('./resolver.js', () => ({
  resolve: mockResolve,
}));

import { resolveAndCacheAvailability } from './resolve-and-cache';

describe('resolveAndCacheAvailability', () => {
  const EXPERT_ID = '00000000-0000-0000-0000-000000000001';
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESOLVER_HORIZON_DAYS;
    delete process.env.MIN_CONSULTATION_MINUTES;
  });

  afterEach(() => {
    delete process.env.RESOLVER_HORIZON_DAYS;
    delete process.env.MIN_CONSULTATION_MINUTES;
  });

  it('happy path: loads inputs, calls resolver, writes cache with the result', async () => {
    mockFindTimezone.mockResolvedValue('Australia/Sydney');
    const rules = [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }];
    const consultations = [
      {
        startAt: new Date('2026-06-01T09:00:00.000Z'),
        endAt: new Date('2026-06-01T10:00:00.000Z'),
      },
    ];
    mockListRules.mockResolvedValue(rules);
    mockListConsultations.mockResolvedValue(consultations);
    const earliest = new Date('2026-06-01T10:00:00.000Z');
    mockResolve.mockReturnValue({ earliestAvailableAt: earliest });

    const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockFindTimezone).toHaveBeenCalledWith(EXPERT_ID);
    expect(mockListRules).toHaveBeenCalledWith(EXPERT_ID);
    expect(mockListConsultations).toHaveBeenCalledWith(
      EXPERT_ID,
      NOW,
      new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000)
    );
    expect(mockResolve).toHaveBeenCalledWith({
      rules,
      baloConsultations: consultations,
      busyBlocks: [],
      timezone: 'Australia/Sydney',
      now: NOW,
      horizonDays: 14,
      minMinutes: 15,
    });
    expect(mockUpsertCache).toHaveBeenCalledWith(EXPERT_ID, earliest);
    expect(mockInfo).toHaveBeenCalled();
    expect(result).toEqual({ earliestAvailableAt: earliest });
  });

  it('returns null and warns when the expert profile has no timezone', async () => {
    mockFindTimezone.mockResolvedValue(null);

    const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(result).toEqual({ earliestAvailableAt: null });
    expect(mockListRules).not.toHaveBeenCalled();
    expect(mockListConsultations).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockUpsertCache).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      { expertProfileId: EXPERT_ID },
      expect.stringContaining('Skipping availability cache rebuild')
    );
  });

  it('writes null to the cache when the resolver returns null', async () => {
    mockFindTimezone.mockResolvedValue('UTC');
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockUpsertCache).toHaveBeenCalledWith(EXPERT_ID, null);
    expect(result).toEqual({ earliestAvailableAt: null });
  });

  it('uses option overrides for now / horizonDays / minMinutes over env defaults', async () => {
    process.env.RESOLVER_HORIZON_DAYS = '7';
    process.env.MIN_CONSULTATION_MINUTES = '30';

    mockFindTimezone.mockResolvedValue('UTC');
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    const customNow = new Date('2026-07-15T00:00:00.000Z');
    await resolveAndCacheAvailability(EXPERT_ID, {
      now: customNow,
      horizonDays: 3,
      minMinutes: 45,
    });

    // Options beat env defaults.
    expect(mockListConsultations).toHaveBeenCalledWith(
      EXPERT_ID,
      customNow,
      new Date(customNow.getTime() + 3 * 24 * 60 * 60 * 1000)
    );
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        now: customNow,
        horizonDays: 3,
        minMinutes: 45,
      })
    );
  });

  it('defaults busyBlocks to [] when none are supplied', async () => {
    mockFindTimezone.mockResolvedValue('UTC');
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ busyBlocks: [] }));
  });

  it('reads horizon + minMinutes from env when neither option nor explicit value is passed', async () => {
    process.env.RESOLVER_HORIZON_DAYS = '21';
    process.env.MIN_CONSULTATION_MINUTES = '20';

    mockFindTimezone.mockResolvedValue('UTC');
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ horizonDays: 21, minMinutes: 20 })
    );
  });
});
