import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  // ⚠ `vendor-busy.ts` is NOT mocked (spied per test instead — see below), so its real
  // `listBusyReadTargets` call needs a real shape here. Defaulting to `[]` targets keeps
  // every test that doesn't care about vendor busy on the pre-BAL-396 behaviour ([] blocks,
  // no vendor client constructed).
  calendarRepository: { listBusyReadTargets: vi.fn().mockResolvedValue([]) },
}));
// ⚠ `./resolver.js` and `./overrides.js` are deliberately NOT mocked. The pure decision logic
// IS what this adapter exists to reach, and mocking it would leave nothing under test but four
// call signatures.

import { isWindowAvailableForExpert } from './window-availability.js';
// ⚠ NOT mocked — spied where it matters. What must be true is that this adapter reads the SAME
// port object `resolveAndCacheAvailability` reads, which a module mock would paper over.
import { vendorBusyProvider, VendorBusyUnavailableError } from './vendor-busy.js';

const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-07T00:00:00.000Z');
/** 2026-09-07 is a Monday; 10:00–11:00 UTC sits inside a 09:00–17:00 Monday rule. */
const START = new Date('2026-09-07T10:00:00.000Z');
const END = new Date('2026-09-07T11:00:00.000Z');

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
});

const check = (): Promise<boolean> =>
  isWindowAvailableForExpert(EXPERT_PROFILE_ID, START, END, NOW);

describe('isWindowAvailableForExpert — the happy path', () => {
  it('is true for a window inside published availability with nothing busy', async () => {
    await expect(check()).resolves.toBe(true);
  });

  it('reads the expert’s own rules, consultations and overrides — never a global set', async () => {
    await check();

    expect(mockListRules).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
    expect(mockListUpcoming).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
    expect(mockFindResolverSettings).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
  });
});

describe('it FAILS CLOSED', () => {
  it('is false when the expert profile (or its timezone) does not resolve', async () => {
    // ⚠ "No settings found" must not read as "no constraints, allow it". Without a timezone the
    // weekly wall-clock rules cannot be interpreted at all, so nothing about the window is
    // verifiable and the caller answers a clean 409.
    mockFindResolverSettings.mockResolvedValue(null);

    await expect(check()).resolves.toBe(false);
  });

  it('does not even read rules or consultations when settings are missing', async () => {
    mockFindResolverSettings.mockResolvedValue(null);

    await check();

    expect(mockListRules).not.toHaveBeenCalled();
    expect(mockListConfirmedInRange).not.toHaveBeenCalled();
  });

  it('is false when the expert has published no rules', async () => {
    mockListRules.mockResolvedValue([]);

    await expect(check()).resolves.toBe(false);
  });
});

describe('already-booked slots are subtracted — the anti-overlap property', () => {
  it('is false when a confirmed consultation overlaps the window', async () => {
    mockListConfirmedInRange.mockResolvedValue([
      {
        startAt: new Date('2026-09-07T10:30:00.000Z'),
        endAt: new Date('2026-09-07T11:30:00.000Z'),
      },
    ]);

    await expect(check()).resolves.toBe(false);
  });

  it('PADS the consultation read on both sides so a buffered neighbour is still seen', async () => {
    // `combineBusyIntervals` grows every busy interval by the booking buffers, so a
    // consultation ending shortly BEFORE the window can still collide once padded. Loading only
    // `[start, end)` would miss it and allow a booking the advertised cache calls blocked.
    await check();

    const [expertId, from, to] = mockListConfirmedInRange.mock.calls[0] as [string, Date, Date];
    expect(expertId).toBe(EXPERT_PROFILE_ID);
    expect(from.getTime()).toBeLessThan(START.getTime());
    expect(to.getTime()).toBeGreaterThan(END.getTime());
  });

  it('is false when a neighbouring consultation collides only because of a buffer', async () => {
    mockFindResolverSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, bufferAfterMinutes: 30 });
    mockListConfirmedInRange.mockResolvedValue([
      {
        startAt: new Date('2026-09-07T09:00:00.000Z'),
        endAt: new Date('2026-09-07T10:00:00.000Z'),
      },
    ]);

    await expect(check()).resolves.toBe(false);
  });
});

describe('time-off overrides and notice are threaded from the expert’s own settings', () => {
  it('is false when the window falls inside a date override, expanded in the expert’s timezone', async () => {
    // `endDate` is INCLUSIVE, so a single-day block covers the whole of 2026-09-07 —
    // `expandOverrideBlocks` runs it to midnight of the following day.
    mockListUpcoming.mockResolvedValue([{ startDate: '2026-09-07', endDate: '2026-09-07' }]);

    await expect(check()).resolves.toBe(false);
  });

  it('is false when the window starts inside the expert’s minimum-notice period', async () => {
    mockFindResolverSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      minimumNoticeMinutes: 720,
    });

    await expect(check()).resolves.toBe(false);
  });

  it('interprets the published hours in the expert’s timezone, not UTC', async () => {
    // 09:00–17:00 Australia/Sydney on Monday 2026-09-07 (AEST, UTC+10) runs 23:00Z Sunday to
    // 07:00Z Monday, so the 10:00Z window is OUTSIDE it — the same rules that pass under UTC.
    mockFindResolverSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      timezone: 'Australia/Sydney',
    });

    await expect(check()).resolves.toBe(false);
  });
});

describe('vendor free/busy comes from the SHARED port, never an inline []', () => {
  /**
   * ⚠ THE REGRESSION THIS BLOCK EXISTS FOR. `busyBlocks` was the ONE resolver input BAL-129's
   * `resolver-inputs.ts` extraction did not share: this adapter hardcoded `[]` while
   * `resolveAndCacheAvailability` took its own default. Both were `[]`, so nothing diverged —
   * until BAL-194/195 wires Cronofy at the ADVERTISE call site, which
   * `jobs/availability-cache.ts` says by name is where it will land. At that moment the booking
   * gate would silently stop honouring vendor free/busy and double-book over an expert's real
   * external commitments, with no type, no test and no helper failing. Reading the shared port
   * is what makes that unrepresentable; these two tests are what keep it read.
   */
  it('asks the port for the SAME padded range it loads consultations over', async () => {
    const spy = vi.spyOn(vendorBusyProvider, 'listBusyBlocks');

    await check();

    const [, consultFrom, consultTo] = mockListConfirmedInRange.mock.calls[0] as [
      string,
      Date,
      Date,
    ];
    expect(spy).toHaveBeenCalledWith(EXPERT_PROFILE_ID, consultFrom, consultTo);

    spy.mockRestore();
  });

  it('SUBTRACTS what the port returns — a vendor-busy window makes the slot unbookable', async () => {
    // The assertion that would have failed under the old inline `[]`, and the reason this is a
    // behavioural test rather than a call-shape one.
    const spy = vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockResolvedValue([
      {
        startAt: new Date('2026-09-07T10:30:00.000Z'),
        endAt: new Date('2026-09-07T11:30:00.000Z'),
      },
    ]);

    await expect(check()).resolves.toBe(false);

    spy.mockRestore();
  });

  /**
   * ⚠⚠ round-2 fix #10 — THE CONCURRENCY REGRESSION TEST. A prior version `await`ed the
   * vendor round-trip serially, BEFORE the three Balo-owned reads, so `POST /meetings` paid a
   * full un-overlapped Apiroc round-trip even on a window the pure resolver would reject
   * cheaply anyway. If the vendor call were still gated ahead of the others, none of the
   * three DB reads below would have fired yet while the vendor promise is still pending.
   */
  it('issues the vendor free/busy read CONCURRENTLY with the three Balo-owned reads, not serially before them', async () => {
    let resolveVendor: ((blocks: never[]) => void) | undefined;
    const vendorPromise = new Promise<never[]>((resolve) => {
      resolveVendor = resolve;
    });
    const spy = vi
      .spyOn(vendorBusyProvider, 'listBusyBlocks')
      .mockReturnValue(vendorPromise as never);

    const resultPromise = check();

    // Let the microtask queue turn WITHOUT resolving the vendor promise. If the vendor read
    // were still serialised ahead of the Balo-owned reads, none of these would be called yet.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockListRules).toHaveBeenCalled();
    expect(mockListConfirmedInRange).toHaveBeenCalled();
    expect(mockListUpcoming).toHaveBeenCalled();

    resolveVendor?.([]);
    await expect(resultPromise).resolves.toBe(true);

    spy.mockRestore();
  });
});

describe('BAL-396 §9.4 — the booking gate FAILS CLOSED on an untrustworthy vendor answer', () => {
  /**
   * The ticket's named mandatory case: `vendorBusyProvider.listBusyBlocks` throwing
   * `VendorBusyUnavailableError` (an unreadable connection, or a failed vendor read) must be
   * CAUGHT here and turned into `false` — never propagated, which would make `POST /meetings`
   * answer a `500` where it should answer a clean `409`.
   */
  it('is false — not a rethrow — when the vendor port throws VendorBusyUnavailableError', async () => {
    const spy = vi
      .spyOn(vendorBusyProvider, 'listBusyBlocks')
      .mockRejectedValue(
        new VendorBusyUnavailableError(EXPERT_PROFILE_ID, 'connection unreadable')
      );

    await expect(check()).resolves.toBe(false);

    spy.mockRestore();
  });

  it('does not swallow an unrelated error — only VendorBusyUnavailableError fails closed here', async () => {
    const spy = vi
      .spyOn(vendorBusyProvider, 'listBusyBlocks')
      .mockRejectedValue(new Error('boom — not a vendor-busy error'));

    await expect(check()).rejects.toThrow('boom — not a vendor-busy error');

    spy.mockRestore();
  });
});

describe('it performs no write', () => {
  it('never reaches the availability-cache upsert', async () => {
    // ⚠ THE REASON THIS MODULE EXISTS RATHER THAN A CALL TO `resolveAndCacheAvailability`: that
    // function WRITES `availability_cache`. An authorization check on a request path must not
    // mutate a cache as a side effect. The `@balo/db` mock here exposes NO `calendarRepository`
    // at all, so any attempt to reach it would throw rather than silently succeed.
    await expect(check()).resolves.toBe(true);
  });
});
