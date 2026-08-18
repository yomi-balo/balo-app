import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockFindResolverSettings,
  mockListRules,
  mockListConsultations,
  mockListUpcoming,
  mockUpsertCache,
  mockResolve,
  mockWarn,
  mockInfo,
} = vi.hoisted(() => ({
  mockFindResolverSettings: vi.fn(),
  mockListRules: vi.fn(),
  mockListConsultations: vi.fn(),
  mockListUpcoming: vi.fn(),
  mockUpsertCache: vi.fn(),
  mockResolve: vi.fn(),
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findResolverSettings: mockFindResolverSettings },
  availabilityRulesRepository: { listByExpertProfileId: mockListRules },
  consultationsRepository: { listConfirmedInRange: mockListConsultations },
  availabilityOverridesRepository: { listUpcoming: mockListUpcoming },
  calendarRepository: {
    upsertAvailabilityCache: mockUpsertCache,
    // ⚠ `vendor-busy.ts` is NOT mocked (spied per test instead), so its real
    // `listBusyReadTargets` call needs a real shape here. `[]` targets keeps every test that
    // doesn't care about vendor busy on the pre-BAL-396 behaviour ([] blocks, no vendor
    // client constructed).
    listBusyReadTargets: vi.fn().mockResolvedValue([]),
  },
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
// ⚠ NOT mocked — spied per test. The property under test is that this module reads the SHARED
// port object, which a module mock would hide behind an equally shared fake.
import { vendorBusyProvider, VendorBusyUnavailableError } from './vendor-busy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * BAL-129 — the consultation read is padded by `CONSULTATION_LOAD_PAD_MS` (one day) on BOTH
 * sides, the SAME pad `window-availability.ts` applies. Before that, this path loaded a bare
 * `[now, horizonEnd]` while the booking gate padded, so a consultation ending just before
 * `now` was invisible here and blocking there once grown by `bufferAfterMinutes`.
 */
const LOAD_PAD_MS = DAY_MS;

/** The padded `[from, to)` this function must ask `listConfirmedInRange` for. */
function expectedLoadRange(now: Date, horizonDays: number): [Date, Date] {
  return [
    new Date(now.getTime() - LOAD_PAD_MS),
    new Date(now.getTime() + horizonDays * DAY_MS + LOAD_PAD_MS),
  ];
}

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
    // Default: no time-off blocks. Individual tests override as needed.
    mockListUpcoming.mockResolvedValue([]);
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
    // No env/option → the default 14-day horizon → consultations query spans 14 days, padded
    // by a day on each side so a buffered neighbour outside the horizon is still seen.
    expect(mockListConsultations).toHaveBeenCalledWith(
      EXPERT_ID,
      ...expectedLoadRange(NOW, DEFAULT_HORIZON_DAYS)
    );
    expect(mockListUpcoming).toHaveBeenCalledWith(EXPERT_ID);
    expect(mockResolve).toHaveBeenCalledWith({
      rules,
      baloConsultations: consultations,
      busyBlocks: [],
      overrideBlocks: [],
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
    expect(result).toEqual({ status: 'completed', earliestAvailableAt: earliest });
  });

  // ⚠ round-2 fix #11 — `status` is what a caller (the BullMQ worker) must branch on to tell
  // a genuine rebuild apart from a skip; `earliestAvailableAt: null` alone is ambiguous with
  // "this expert genuinely has no open slot".
  it('returns status "skipped" and warns when findResolverSettings is null (missing profile or timezone)', async () => {
    mockFindResolverSettings.mockResolvedValue(null);

    const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(result).toEqual({
      status: 'skipped',
      skipReason: 'expert_settings_not_found',
      earliestAvailableAt: null,
    });
    expect(mockListRules).not.toHaveBeenCalled();
    expect(mockListConsultations).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockUpsertCache).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      { expertProfileId: EXPERT_ID },
      expect.stringContaining('Skipping availability cache rebuild')
    );
  });

  it('loads overrides and expands each [startDate, endDate] to an end-inclusive whole-day UTC interval', async () => {
    // Sydney in June is AEST (UTC+10, no DST): local midnight = 14:00 UTC the
    // prior day. endDate is INCLUSIVE, so the interval runs to midnight of the
    // day AFTER endDate (2026-06-12 local → 2026-06-11T14:00:00Z).
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'Australia/Sydney' }));
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockListUpcoming.mockResolvedValue([
      { id: 'o1', startDate: '2026-06-10', endDate: '2026-06-11', label: 'Leave' },
    ]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideBlocks: [
          {
            startAt: new Date('2026-06-09T14:00:00.000Z'),
            endAt: new Date('2026-06-11T14:00:00.000Z'),
          },
        ],
      })
    );
  });

  it('expands a single-day override (startDate === endDate) to exactly one whole UTC day', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockListUpcoming.mockResolvedValue([
      { id: 'o1', startDate: '2026-12-25', endDate: '2026-12-25', label: null },
    ]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideBlocks: [
          {
            startAt: new Date('2026-12-25T00:00:00.000Z'),
            endAt: new Date('2026-12-26T00:00:00.000Z'),
          },
        ],
      })
    );
  });

  it('writes null to the cache when the resolver returns null', async () => {
    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    expect(mockUpsertCache).toHaveBeenCalledWith(EXPERT_ID, null);
    // ⚠ round-2 fix #11 — this IS a completed rebuild (the resolver ran and wrote the cache);
    // `earliestAvailableAt: null` here is the legitimate "no open slot" answer, not a skip.
    expect(result).toEqual({ status: 'completed', earliestAvailableAt: null });
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
      ...expectedLoadRange(customNow, 3)
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

  it('rejects a non-positive RESOLVER_HORIZON_DAYS (0 / negative) → falls through to the default', async () => {
    // 0 or negative would collapse the window to empty ("never available"); a
    // misconfigured env must not silently take a profile offline.
    for (const bad of ['0', '-5']) {
      vi.clearAllMocks();
      process.env.RESOLVER_HORIZON_DAYS = bad;
      mockFindResolverSettings.mockResolvedValue(settings());
      mockListRules.mockResolvedValue([]);
      mockListConsultations.mockResolvedValue([]);
      mockResolve.mockReturnValue({ earliestAvailableAt: null });

      await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ horizonDays: DEFAULT_HORIZON_DAYS })
      );
    }
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
    const [expectedFrom, expectedEnd] = expectedLoadRange(NOW, DEFAULT_HORIZON_DAYS);
    expect(mockListConsultations).toHaveBeenCalledWith(EXPERT_ID, expectedFrom, expectedEnd);
    expect(Number.isFinite(expectedEnd.getTime())).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ horizonDays: DEFAULT_HORIZON_DAYS, minMinutes: 15 })
    );
  });

  it('reads busyBlocks from the SHARED vendor port when none are supplied', async () => {
    // ⚠ BAL-129: NOT an inline `[]`. The booking gate reads vendor free/busy from the SAME
    // `vendorBusyProvider`, so BAL-194/195 wiring Cronofy in that one place reaches BOTH the
    // advertised answer and the accept check. The spy is what makes "shared" a test rather than
    // a comment: an inlined default here would never call it.
    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    const vendorBlock = {
      startAt: new Date('2026-06-02T01:00:00.000Z'),
      endAt: new Date('2026-06-02T02:00:00.000Z'),
    };
    const spy = vi
      .spyOn(vendorBusyProvider, 'listBusyBlocks')
      .mockResolvedValue([vendorBlock] as never);

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

    const [from, to] = expectedLoadRange(NOW, DEFAULT_HORIZON_DAYS);
    expect(spy).toHaveBeenCalledWith(EXPERT_ID, from, to);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ busyBlocks: [vendorBlock] })
    );

    spy.mockRestore();
  });

  describe('BAL-396 §9.4 — the advertise path SKIPS the cache write on an untrustworthy vendor answer', () => {
    /**
     * The ticket's ruling: overwriting `availability_cache` with a result computed WITHOUT
     * the vendor's data would replace last-known-good with a possibly-wrong answer — worse
     * than leaving the stale one. `vendorBusyProvider.listBusyBlocks` throwing
     * `VendorBusyUnavailableError` must therefore skip `upsertAvailabilityCache` entirely,
     * not merely fall back to `busyBlocks: []`.
     */
    it('does not write the cache when the vendor port throws VendorBusyUnavailableError', async () => {
      mockFindResolverSettings.mockResolvedValue(settings());
      mockListRules.mockResolvedValue([]);
      mockListConsultations.mockResolvedValue([]);

      const spy = vi
        .spyOn(vendorBusyProvider, 'listBusyBlocks')
        .mockRejectedValue(new VendorBusyUnavailableError(EXPERT_ID, 'connection unreadable'));

      const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

      expect(result).toEqual({
        status: 'skipped',
        skipReason: 'vendor_busy_unavailable',
        earliestAvailableAt: null,
      });
      expect(mockUpsertCache).not.toHaveBeenCalled();
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ expertProfileId: EXPERT_ID }),
        expect.stringContaining('Skipping availability cache rebuild')
      );

      spy.mockRestore();
    });

    it('skipReason is "vendor_read_error" (not "vendor_busy_unavailable") for an unclassified vendor rejection', async () => {
      mockFindResolverSettings.mockResolvedValue(settings());
      mockListRules.mockResolvedValue([]);
      mockListConsultations.mockResolvedValue([]);

      const spy = vi
        .spyOn(vendorBusyProvider, 'listBusyBlocks')
        .mockRejectedValue(new Error('unexpected programmer error'));

      const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW });

      expect(result).toEqual({
        status: 'skipped',
        skipReason: 'vendor_read_error',
        earliestAvailableAt: null,
      });
      expect(mockUpsertCache).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it('an explicit busyBlocks seed override bypasses the vendor port entirely, so a vendor outage cannot affect it', async () => {
      mockFindResolverSettings.mockResolvedValue(settings());
      mockListRules.mockResolvedValue([]);
      mockListConsultations.mockResolvedValue([]);
      mockResolve.mockReturnValue({ earliestAvailableAt: null });

      const spy = vi.spyOn(vendorBusyProvider, 'listBusyBlocks');

      const result = await resolveAndCacheAvailability(EXPERT_ID, { now: NOW, busyBlocks: [] });

      expect(spy).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'completed', earliestAvailableAt: null });
      expect(mockUpsertCache).toHaveBeenCalledWith(EXPERT_ID, null);

      spy.mockRestore();
    });
  });

  it('an explicit busyBlocks option is a SEED-ONLY override — the vendor port is not consulted', async () => {
    // The seeder injects synthetic vendor busy; nothing in production does. Documented in
    // `ResolveAndCacheOptions.busyBlocks` as the one place advertise and accept still diverge.
    mockFindResolverSettings.mockResolvedValue(settings());
    mockListRules.mockResolvedValue([]);
    mockListConsultations.mockResolvedValue([]);
    mockResolve.mockReturnValue({ earliestAvailableAt: null });

    const spy = vi.spyOn(vendorBusyProvider, 'listBusyBlocks');
    const seeded = {
      startAt: new Date('2026-06-03T01:00:00.000Z'),
      endAt: new Date('2026-06-03T02:00:00.000Z'),
    };

    await resolveAndCacheAvailability(EXPERT_ID, { now: NOW, busyBlocks: [seeded] });

    expect(spy).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ busyBlocks: [seeded] }));

    spy.mockRestore();
  });
});
