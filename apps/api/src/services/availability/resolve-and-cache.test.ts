import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockFindResolverSettings,
  mockListRules,
  mockListConsultations,
  mockUpsertCache,
  mockResolve,
  mockWarn,
  mockInfo,
} = vi.hoisted(() => ({
  mockFindResolverSettings: vi.fn(),
  mockListRules: vi.fn(),
  mockListConsultations: vi.fn(),
  mockUpsertCache: vi.fn(),
  mockResolve: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findResolverSettings: mockFindResolverSettings },
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Full resolver settings as returned by `findResolverSettings`. */
const settings = (overrides: Partial<Record<string, unknown>> = {}) => ({
  timezone: 'Australia/Sydney',
  bufferBeforeMinutes: 15,
  bufferAfterMinutes: 30,
  minimumNoticeMinutes: 120,
  ...overrides,
});

// Default horizon when no explicit option and no RESOLVER_HORIZON_DAYS env (the
// look-ahead horizon is platform config, BAL-398 — not a per-expert column).
const DEFAULT_HORIZON_DAYS = 14;

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

  it('happy path: loads settings, threads booking rules into the resolver, writes cache', async () => {
    mockFindResolverSettings.mockResolvedValue(settings());
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

    expect(mockFindResolverSettings).toHaveBeenCalledWith(EXPERT_ID);
    expect(mockListRules).toHaveBeenCalledWith(EXPERT_ID);
    // No env/option → the default 14-day horizon → consultations query spans 14 days.
    expect(mockListConsultations).toHaveBeenCalledWith(
      EXPERT_ID,
      NOW,
      new Date(NOW.getTime() + DEFAULT_HORIZON_DAYS * DAY_MS)
    );
    expect(mockResolve).toHaveBeenCalledWith({
      rules,
      baloConsultations: consultations,
      busyBlocks: [],
      timezone: 'Australia/Sydney',
      now: NOW,
      horizonDays: DEFAULT_HORIZON_DAYS,
      minMinutes: 15,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 30,
      minimumNoticeMinutes: 120,
    });
    expect(mockUpsertCache).toHaveBeenCalledWith(EXPERT_ID, earliest);
    expect(mockInfo).toHaveBeenCalled();
    expect(result).toEqual({ earliestAvailableAt: earliest });
  });

  it('returns null and warns when the expert profile is not found', async () => {
    mockFindResolverSettings.mockResolvedValue(null);

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
    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockUpsertCache).toHaveBeenCalledWith(EXPERT_ID, null);
    expect(result).toEqual({ earliestAvailableAt: null });
  });

  it('lets an explicit horizonDays option win over env and the default', async () => {
    process.env.RESOLVER_HORIZON_DAYS = '7';
    process.env.MIN_CONSULTATION_MINUTES = '30';

    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    const customNow = new Date('2026-07-15T00:00:00.000Z');
    await resolveAndCacheAvailability(EXPERT_ID, {
      now: customNow,
      horizonDays: 3,
      minMinutes: 45,
    });

    expect(mockListConsultations).toHaveBeenCalledWith(
      EXPERT_ID,
      customNow,
      new Date(customNow.getTime() + 3 * DAY_MS)
    );
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ now: customNow, horizonDays: 3, minMinutes: 45 })
    );
  });

  it('lets a valid RESOLVER_HORIZON_DAYS env override the default', async () => {
    process.env.RESOLVER_HORIZON_DAYS = '21';
    process.env.MIN_CONSULTATION_MINUTES = '20';

    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ horizonDays: 21, minMinutes: 20 })
    );
  });

  it('falls through to the default horizon (finite horizonEnd) when env vars are non-numeric', async () => {
    process.env.RESOLVER_HORIZON_DAYS = 'abc';
    process.env.MIN_CONSULTATION_MINUTES = 'not-a-number';

    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    // Non-numeric env is ignored → the 14-day default is used, and the
    // consultations query gets a finite horizonEnd (not Invalid Date).
    const expectedEnd = new Date(NOW.getTime() + DEFAULT_HORIZON_DAYS * DAY_MS);
    expect(mockListConsultations).toHaveBeenCalledWith(EXPERT_ID, NOW, expectedEnd);
    expect(Number.isFinite(expectedEnd.getTime())).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ horizonDays: DEFAULT_HORIZON_DAYS, minMinutes: 15 })
    );
  });

  it('defaults busyBlocks to [] when none are supplied', async () => {
    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ busyBlocks: [] }));
  });
});
