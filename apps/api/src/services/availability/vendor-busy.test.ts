import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListBusyReadTargets, mockCallApiroc, mockGetApirocClient, mockFreeBusyGet } =
  vi.hoisted(() => ({
    mockListBusyReadTargets: vi.fn(),
    mockCallApiroc: vi.fn(),
    mockGetApirocClient: vi.fn(),
    mockFreeBusyGet: vi.fn(),
  }));

vi.mock('@balo/db', () => ({
  calendarRepository: { listBusyReadTargets: mockListBusyReadTargets },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  // ⚠ THE ONE-FALLIBLE-CALL CONTRACT, ASSERTED FROM THE MOCK SIDE. Real `callApiroc` runs
  // `fn` inside an AsyncLocalStorage capture sink; the mock just runs `fn` and lets a
  // rejection propagate, which is all `vendor-busy.ts` depends on for correctness. Its own
  // CALL COUNT is what proves "one `callApiroc` per account" below.
  callApiroc: (operation: string, fn: () => Promise<unknown>) => mockCallApiroc(operation, fn),
  getApirocClient: () => mockGetApirocClient(),
}));

import {
  vendorBusyProvider,
  VendorBusyUnavailableError,
  isImmediatelyRetryable,
  FREE_BUSY_MAX_ATTEMPTS,
} from './vendor-busy.js';
// ⚠ The REAL error class and the REAL classifier — `vendor-busy.ts` imports them from
// the submodules precisely so the barrel mock above cannot stub them out. If these ever
// resolve to `undefined`, every `instanceof` below silently stops classifying.
import { ApirocError } from '../../lib/apiroc/errors.js';
import type { ApirocFailureKind } from '../../lib/apiroc/errors.js';

const EXPERT_ID = '66666666-6666-4666-8666-666666666666';
const FROM = new Date('2026-09-07T00:00:00.000Z');
const TO = new Date('2026-09-21T00:00:00.000Z');

/** A readable, ACTIVE, provisioned target with one conflict-checked calendar. */
function readableTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connectionId: 'conn-1',
    provider: 'google',
    endUserAccountId: 'eua-1',
    credentialStatus: 'ACTIVE' as const,
    calendarIds: ['cal-1'],
    provisioned: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCallApiroc.mockImplementation((_operation: string, fn: () => Promise<unknown>) => fn());
  mockGetApirocClient.mockReturnValue({ freeBusy: { get: mockFreeBusyGet } });
});

/**
 * BAL-396 §9 — the vendor free/busy PORT, now LIVE. This is the ticket's named
 * HIGHEST-RISK step (§12.1): too permissive and every connected expert can be double-booked
 * in front of a paying client; too strict and every connected expert becomes unbookable.
 */
describe('vendorBusyProvider.listBusyBlocks', () => {
  describe('§9.3 — the rollout seam', () => {
    it('answers [] and NEVER constructs a client when the expert has no Apiroc targets', async () => {
      mockListBusyReadTargets.mockResolvedValue([]);

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).resolves.toEqual([]);

      // ⚠ THE ASSERTION THAT MAKES THE MERGE COMMIT A BEHAVIOURAL NO-OP: an unset
      // `APIROC_API_KEY` in dev/CI must not be able to throw `ApirocConfigError` into the
      // booking path for an expert with no connection at all.
      expect(mockGetApirocClient).not.toHaveBeenCalled();
      expect(mockCallApiroc).not.toHaveBeenCalled();
    });
  });

  describe('§9.4 — an unreadable connection throws, it never answers []', () => {
    // ⚠ round-2 fix #5 — these targets carry a real conflict-checked calendar
    // (`calendarIds: ['cal-1']`, from `readableTarget`'s default), i.e. this connection's
    // data actually matters to the answer. That is what must still throw when it becomes
    // unreadable. A connection the expert already opted every calendar OUT of is a
    // DIFFERENT case, covered separately below (it must NOT throw).
    it.each([
      ['SYNC_PENDING', 'SYNC_PENDING'],
      ['EXPIRED', 'EXPIRED'],
      ['REVOKED', 'REVOKED'],
    ])(
      'throws when a connection with a conflict-checked calendar is %s',
      async (_label, credentialStatus) => {
        mockListBusyReadTargets.mockResolvedValue([readableTarget({ credentialStatus })]);

        await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).rejects.toBeInstanceOf(
          VendorBusyUnavailableError
        );
        expect(mockCallApiroc).not.toHaveBeenCalled();
      }
    );

    it('throws when an ACTIVE connection has zero sub-calendar rows (never provisioned)', async () => {
      mockListBusyReadTargets.mockResolvedValue([
        readableTarget({ provisioned: false, calendarIds: [] }),
      ]);

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).rejects.toBeInstanceOf(
        VendorBusyUnavailableError
      );
    });

    it('does NOT throw when an ACTIVE, provisioned connection simply has no conflict-checked calendar — the expert’s explicit choice', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget({ calendarIds: [] })]);

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).resolves.toEqual([]);
      expect(mockCallApiroc).not.toHaveBeenCalled();
    });

    it.each([
      ['SYNC_PENDING', 'SYNC_PENDING'],
      ['EXPIRED', 'EXPIRED'],
      ['REVOKED', 'REVOKED'],
    ])(
      // round-2 fix #5 — a provisioned connection the expert opted every calendar out of
      // contributes nothing regardless of credential health, so it must NOT take an
      // otherwise-healthy connection down with it. vendor-busy.test.ts (pre-fix) pinned the
      // opposite: this connection alone going %s used to make the whole expert unbookable.
      'does NOT throw, and does not even read, an opted-out connection that goes %s alongside a healthy one',
      async (_label, credentialStatus) => {
        mockListBusyReadTargets.mockResolvedValue([
          readableTarget({
            connectionId: 'conn-healthy',
            endUserAccountId: 'eua-healthy',
            calendarIds: ['cal-work'],
          }),
          readableTarget({
            connectionId: 'conn-opted-out',
            endUserAccountId: 'eua-opted-out',
            credentialStatus,
            calendarIds: [],
          }),
        ]);
        mockFreeBusyGet.mockResolvedValue([
          {
            calendarId: 'cal-work',
            busySlots: [
              {
                start: { dateTime: '2026-09-07T10:00:00Z' },
                end: { dateTime: '2026-09-07T11:00:00Z' },
              },
            ],
          },
        ]);

        const result = await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

        expect(result).toEqual([
          { startAt: new Date('2026-09-07T10:00:00Z'), endAt: new Date('2026-09-07T11:00:00Z') },
        ]);
        // Only the healthy account was ever read.
        expect(mockFreeBusyGet).toHaveBeenCalledTimes(1);
        expect(mockFreeBusyGet).toHaveBeenCalledWith('eua-healthy', expect.anything());
      }
    );

    it('throws VendorBusyUnavailableError (not a bare Error) when any vendor read rejects — partial data is not an answer', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockFreeBusyGet.mockRejectedValue(new Error('network blip'));

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).rejects.toBeInstanceOf(
        VendorBusyUnavailableError
      );
    });
  });

  describe('the fan-out — one callApiroc per account, union across accounts', () => {
    it('unions busy blocks across two accounts', async () => {
      mockListBusyReadTargets.mockResolvedValue([
        readableTarget({
          connectionId: 'conn-1',
          endUserAccountId: 'eua-1',
          calendarIds: ['cal-1'],
        }),
        readableTarget({
          connectionId: 'conn-2',
          endUserAccountId: 'eua-2',
          calendarIds: ['cal-2'],
        }),
      ]);
      mockFreeBusyGet.mockImplementation((accountId: string) =>
        Promise.resolve([
          {
            calendarId: accountId === 'eua-1' ? 'cal-1' : 'cal-2',
            busySlots: [
              {
                start: { dateTime: '2026-09-07T10:00:00Z' },
                end: { dateTime: '2026-09-07T11:00:00Z' },
              },
            ],
          },
        ])
      );

      const result = await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          {
            startAt: new Date('2026-09-07T10:00:00Z'),
            endAt: new Date('2026-09-07T11:00:00Z'),
          },
        ])
      );
    });

    it('calls callApiroc exactly once per account — never one callApiroc wrapping the whole fan-out', async () => {
      mockListBusyReadTargets.mockResolvedValue([
        readableTarget({
          connectionId: 'conn-1',
          endUserAccountId: 'eua-1',
          calendarIds: ['cal-1'],
        }),
        readableTarget({
          connectionId: 'conn-2',
          endUserAccountId: 'eua-2',
          calendarIds: ['cal-2'],
        }),
      ]);
      mockFreeBusyGet.mockResolvedValue([]);

      await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

      expect(mockCallApiroc).toHaveBeenCalledTimes(2);
      expect(mockCallApiroc).toHaveBeenCalledWith('freeBusy.get', expect.any(Function));
    });

    it('passes the required calendarIds, timeZone UTC and the caller’s [from, to) range', async () => {
      mockListBusyReadTargets.mockResolvedValue([
        readableTarget({ endUserAccountId: 'eua-1', calendarIds: ['cal-1', 'cal-2'] }),
      ]);
      mockFreeBusyGet.mockResolvedValue([]);

      await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

      expect(mockFreeBusyGet).toHaveBeenCalledWith('eua-1', {
        startDateTime: FROM,
        endDateTime: TO,
        timeZone: 'UTC',
        calendarIds: ['cal-1', 'cal-2'],
      });
    });
  });

  describe('parity parsing — PARSE, NEVER STRING-COMPARE', () => {
    it('parses Google (UTC / trailing Z) and Microsoft (Etc/UTC / .000Z) shapes identically', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockFreeBusyGet.mockResolvedValue([
        {
          calendarId: 'cal-1',
          busySlots: [
            {
              start: { dateTime: '2026-09-07T10:00:00Z', timeZone: 'UTC' },
              end: { dateTime: '2026-09-07T11:00:00Z', timeZone: 'UTC' },
            },
            {
              start: { dateTime: '2026-09-07T14:00:00.000Z', timeZone: 'Etc/UTC' },
              end: { dateTime: '2026-09-07T15:00:00.000Z', timeZone: 'Etc/UTC' },
            },
          ],
        },
      ]);

      const result = await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

      expect(result).toEqual([
        { startAt: new Date('2026-09-07T10:00:00Z'), endAt: new Date('2026-09-07T11:00:00Z') },
        { startAt: new Date('2026-09-07T14:00:00Z'), endAt: new Date('2026-09-07T15:00:00Z') },
      ]);
    });

    // ⚠ round-2 fix #1 — pre-fix, this test asserted the OPPOSITE: that a malformed slot was
    // silently dropped and the caller answered with whatever parsed. `BusySlot.start`/`end`
    // and `EventDateTime.dateTime` are all OPTIONAL BY TYPE (not just under corruption), so a
    // real commitment arriving in that shape would vanish and `isWindowBookable` would see the
    // window as free — double-booking the expert in front of a paying client. Partial data is
    // not an answer: ANY unparseable slot in the response must fail the whole read closed.
    it('throws VendorBusyUnavailableError — never answers with a partial set — when any slot is unparseable (missing start/end, or inverted/zero-length)', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockFreeBusyGet.mockResolvedValue([
        {
          calendarId: 'cal-1',
          busySlots: [
            { start: {}, end: { dateTime: '2026-09-07T11:00:00Z' } },
            {
              start: { dateTime: '2026-09-07T09:00:00Z' },
              end: { dateTime: '2026-09-07T09:30:00Z' },
            },
          ],
        },
      ]);

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).rejects.toBeInstanceOf(
        VendorBusyUnavailableError
      );
    });

    it('throws when a slot is inverted or zero-length even though every field parsed cleanly', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockFreeBusyGet.mockResolvedValue([
        {
          calendarId: 'cal-1',
          busySlots: [
            {
              start: { dateTime: '2026-09-07T12:00:00Z' },
              end: { dateTime: '2026-09-07T12:00:00Z' },
            },
          ],
        },
      ]);

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).rejects.toBeInstanceOf(
        VendorBusyUnavailableError
      );
    });

    it('treats a calendar with no busySlots at all as contributing nothing', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockFreeBusyGet.mockResolvedValue([{ calendarId: 'cal-1' }]);

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).resolves.toEqual([]);
    });
  });

  describe('round-2 fix #2 — timeZone is honoured, a naive dateTime is never assumed UTC', () => {
    it('resolves a naive (no-offset) dateTime through its sibling timeZone rather than parsing it as server-local', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockFreeBusyGet.mockResolvedValue([
        {
          calendarId: 'cal-1',
          busySlots: [
            {
              // No trailing Z / offset — a NAIVE wall-clock value, per the SDK's own field
              // doc. Europe/London is UTC+1 on this date (BST), so 10:00 local is 09:00Z.
              start: { dateTime: '2026-09-07T10:00:00', timeZone: 'Europe/London' },
              end: { dateTime: '2026-09-07T11:00:00', timeZone: 'Europe/London' },
            },
          ],
        },
      ]);

      const result = await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

      expect(result).toEqual([
        { startAt: new Date('2026-09-07T09:00:00Z'), endAt: new Date('2026-09-07T10:00:00Z') },
      ]);
    });

    it('throws when a naive dateTime has no timeZone to resolve it against', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockFreeBusyGet.mockResolvedValue([
        {
          calendarId: 'cal-1',
          busySlots: [
            {
              start: { dateTime: '2026-09-07T10:00:00' },
              end: { dateTime: '2026-09-07T11:00:00' },
            },
          ],
        },
      ]);

      await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).rejects.toBeInstanceOf(
        VendorBusyUnavailableError
      );
    });

    it('resolves through the sibling timeZone identically regardless of the HOST process TZ — never server-local', async () => {
      const originalTz = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
        mockFreeBusyGet.mockResolvedValue([
          {
            calendarId: 'cal-1',
            busySlots: [
              {
                // Same naive value as above. If the code ever regresses to
                // `new Date(dateTime)` on a naive string, this would parse as
                // America/New_York local time instead of Europe/London and the assertion
                // below would fail.
                start: { dateTime: '2026-09-07T10:00:00', timeZone: 'Europe/London' },
                end: { dateTime: '2026-09-07T11:00:00', timeZone: 'Europe/London' },
              },
            ],
          },
        ]);

        const result = await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

        expect(result).toEqual([
          { startAt: new Date('2026-09-07T09:00:00Z'), endAt: new Date('2026-09-07T10:00:00Z') },
        ]);
      } finally {
        process.env.TZ = originalTz;
      }
    });
  });

  // ── BAL-470 — transient-failure retry on the free/busy path ──────────────
  describe('transient-failure retry (BAL-470)', () => {
    function apirocError(kind: ApirocFailureKind, retryAfterSeconds?: number): ApirocError {
      return new ApirocError({ kind, operation: 'freeBusy.get', retryAfterSeconds });
    }

    /**
     * ⚠ THE POLICY, STATED AS A TABLE. `network` and `server_error` are the two kinds
     * `classifyRetry` marks retryable WITHOUT a backoff, so they are the only two safe to act
     * on inline. `rate_limited` is retryable but always carries `afterMs` (a vendor
     * `Retry-After`, else the 5s default) — parking a request the booking gate awaits for
     * ≥5s is not a resilience win, it is an outage with extra steps.
     */
    it.each([
      ['network', true],
      ['server_error', true],
      ['rate_limited', false],
      ['unauthorized', false],
      ['forbidden', false],
      ['not_found', false],
      ['validation', false],
      ['unknown', false],
    ] as ReadonlyArray<readonly [ApirocFailureKind, boolean]>)(
      'isImmediatelyRetryable(%s) === %s',
      (kind, expected) => {
        expect(isImmediatelyRetryable(apirocError(kind))).toBe(expected);
      }
    );

    it('does NOT retry a rate_limited failure even when Retry-After is small', () => {
      // Even a 1s Retry-After is a backoff, and backoffs belong to jobs, not request paths.
      expect(isImmediatelyRetryable(apirocError('rate_limited', 1))).toBe(false);
    });

    it('does NOT retry a non-Apiroc error (the unparseable-slot throw)', () => {
      expect(isImmediatelyRetryable(new Error('3 unparseable busy slot(s)'))).toBe(false);
    });

    it('a single transient network blip no longer blanks availability', async () => {
      mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
      mockGetApirocClient.mockReturnValue({ freeBusy: { get: mockFreeBusyGet } });
      mockCallApiroc
        .mockRejectedValueOnce(apirocError('network'))
        .mockImplementationOnce((_op: string, fn: () => Promise<unknown>) => fn());
      mockFreeBusyGet.mockResolvedValue([
        {
          busySlots: [
            {
              start: { dateTime: '2026-09-07T09:00:00', timeZone: 'UTC' },
              end: { dateTime: '2026-09-07T10:00:00', timeZone: 'UTC' },
            },
          ],
        },
      ]);

      const result = await vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO);

      expect(result).toEqual([
        { startAt: new Date('2026-09-07T09:00:00Z'), endAt: new Date('2026-09-07T10:00:00Z') },
      ]);
      // ⚠ Two SEPARATE callApiroc invocations, not one reused sink — the one-fallible-call
      // contract is per-invocation, and a shared sink would attribute attempt 1's captured
      // evidence to attempt 2's error.
      expect(mockCallApiroc).toHaveBeenCalledTimes(2);
    });

    /**
     * ⚠ THE BUDGET IS PINNED AS A LITERAL BELOW, NOT AS `FREE_BUSY_MAX_ATTEMPTS`. Asserting
     * the call count equals the constant is true by construction — raise the constant to 5
     * and the assertion still passes while the booking gate quietly waits through five vendor
     * round-trips. The literals here are the actual product decision; the separate assertion
     * at the end ties the exported constant to them.
     *
     * `server_error` is the only kind that earns a second call. `rate_limited` is retryable
     * per `classifyRetry` but carries a backoff, and a backoff belongs to a job, not to a
     * request the booking gate is awaiting. `unauthorized` is a credential problem — a
     * retry cannot fix it, it needs a reconnect.
     */
    it.each([
      ['server_error — transient, earns the retry', 'server_error', undefined, 2],
      ['rate_limited — retryable but backed off, so NOT inline', 'rate_limited', 30, 1],
      ['unauthorized — permanent, needs a reconnect not a retry', 'unauthorized', undefined, 1],
    ] as ReadonlyArray<readonly [string, ApirocFailureKind, number | undefined, number]>)(
      'a persistent %s failure makes exactly %4$s vendor call(s)',
      async (_label, kind, retryAfterSeconds, expectedCalls) => {
        mockListBusyReadTargets.mockResolvedValue([readableTarget()]);
        mockGetApirocClient.mockReturnValue({ freeBusy: { get: mockFreeBusyGet } });
        mockCallApiroc.mockRejectedValue(apirocError(kind, retryAfterSeconds));

        await expect(vendorBusyProvider.listBusyBlocks(EXPERT_ID, FROM, TO)).rejects.toBeInstanceOf(
          VendorBusyUnavailableError
        );
        expect(mockCallApiroc).toHaveBeenCalledTimes(expectedCalls);
      }
    );

    it('the exported budget is 2 — one call plus one retry, and no more', () => {
      expect(FREE_BUSY_MAX_ATTEMPTS).toBe(2);
    });
  });
});
