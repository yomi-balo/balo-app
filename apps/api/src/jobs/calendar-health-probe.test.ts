import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConnection } from '@balo/db';

const {
  mockListConnectionsDueForHealthCheck,
  mockMarkCredentialChecked,
  mockSetCredentialStatus,
  mockFindSubCalendarsByConnectionId,
  mockCalendarsListGet,
  mockProvisionConnection,
  mockApplyCredentialFailure,
  mockEnqueueAvailabilityCacheRebuild,
  mockEnqueueSubscriptionReconcile,
  mockTrackServer,
  mockClassifyCredentialFailure,
  mockLog,
  MockApirocError,
} = vi.hoisted(() => {
  /**
   * A minimal stand-in for `ApirocError` that satisfies `instanceof ApirocError` (the mocked
   * `../lib/apiroc/index.js` below exports THIS class as `ApirocError`, so it IS the class the
   * job code sees) and carries the fields `classifyCredentialFailure` reads.
   */
  class MockApirocErrorImpl extends Error {
    readonly kind: string;
    readonly wireMessage?: string;
    readonly operation: string;
    readonly status?: number;
    constructor(params: {
      kind: string;
      wireMessage?: string;
      operation?: string;
      status?: number;
    }) {
      super(`mock apiroc error (${params.kind})`);
      this.name = 'ApirocError';
      this.kind = params.kind;
      this.wireMessage = params.wireMessage;
      this.operation = params.operation ?? 'calendars.list';
      this.status = params.status;
    }
  }

  return {
    mockListConnectionsDueForHealthCheck: vi.fn(),
    mockMarkCredentialChecked: vi.fn(),
    mockSetCredentialStatus: vi.fn(),
    mockFindSubCalendarsByConnectionId: vi.fn(),
    mockCalendarsListGet: vi.fn(),
    mockProvisionConnection: vi.fn(),
    mockApplyCredentialFailure: vi.fn(),
    mockEnqueueAvailabilityCacheRebuild: vi.fn(),
    mockEnqueueSubscriptionReconcile: vi.fn(),
    mockTrackServer: vi.fn(),
    mockClassifyCredentialFailure: vi.fn(),
    mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    MockApirocError: MockApirocErrorImpl,
  };
});

vi.mock('@balo/db', () => ({
  calendarRepository: {
    listConnectionsDueForHealthCheck: mockListConnectionsDueForHealthCheck,
    markCredentialChecked: mockMarkCredentialChecked,
    setCredentialStatus: mockSetCredentialStatus,
    findSubCalendarsByConnectionId: mockFindSubCalendarsByConnectionId,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CALENDAR_SERVER_EVENTS: {
    SYNC_PENDING_AUTO_RESOLVED: 'calendar_sync_pending_auto_resolved',
    RECONNECT_RESOLVED: 'calendar_reconnect_resolved',
  },
  toCalendarEventProvider: (p: string) => (p === 'google' || p === 'microsoft' ? p : undefined),
}));

vi.mock('../lib/apiroc/index.js', () => ({
  ApirocError: MockApirocError,
  callApiroc: async (_operation: string, fn: () => Promise<unknown>) => fn(),
  getApirocClient: () => ({ calendars: { list: mockCalendarsListGet } }),
  classifyCredentialFailure: mockClassifyCredentialFailure,
}));

vi.mock('../services/calendar/apiroc-connection.js', () => ({
  provisionConnection: mockProvisionConnection,
}));

vi.mock('../services/calendar/credential-status.js', () => ({
  applyCredentialFailure: mockApplyCredentialFailure,
}));

vi.mock('./availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mockEnqueueAvailabilityCacheRebuild,
  // round-2 fix #8 — real value, not a stub: `calendar-health-probe.ts` asserts
  // `PROBE_INTERVAL_MS > STALENESS_CHECK_THRESHOLD_MS` at module load, so this mock must
  // carry the actual production number for that guard (and the dedicated test below) to mean
  // anything.
  STALENESS_CHECK_THRESHOLD_MS: 15 * 60 * 1000,
}));

vi.mock('./calendar-subscription-reconcile.js', () => ({
  enqueueSubscriptionReconcile: mockEnqueueSubscriptionReconcile,
}));

import {
  CALENDAR_HEALTH_PROBE_BATCH_LIMIT,
  PROBE_INTERVAL_MS,
  runCalendarHealthProbe,
} from './calendar-health-probe.js';
import { STALENESS_CHECK_THRESHOLD_MS } from './availability-cache.js';

const NOW = new Date('2026-08-18T12:00:00.000Z');

function makeConnection(overrides: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn-1',
    expertProfileId: 'expert-1',
    endUserAccountId: 'eua-1',
    provider: 'google',
    providerEmail: 'expert@example.com',
    credentialStatus: 'ACTIVE',
    credentialCheckedAt: null,
    reconnectNotifiedAt: null,
    lastSyncedAt: null,
    targetCalendarId: 'primary-cal',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });
  // Default: an ACTIVE connection is already provisioned (has sub-calendar rows), so the
  // "ACTIVE-but-unreadable" re-provision path only fires in the tests that explicitly want it.
  mockFindSubCalendarsByConnectionId.mockResolvedValue([
    { calendarId: 'primary-cal', conflictCheck: true },
  ]);
  mockClassifyCredentialFailure.mockImplementation(
    (err: { kind: string; wireMessage?: string }) => {
      if (err.kind === 'unauthorized' && err.wireMessage === 'Token has been expired or revoked.') {
        return { kind: 'reconnect_required', marker: err.wireMessage };
      }
      if (err.kind === 'unauthorized') return { kind: 'platform_auth_failure' };
      if (err.kind === 'server_error') return { kind: 'transient' };
      return { kind: 'other' };
    }
  );
});

/**
 * ⚠⚠ round-2 fix #8 — THE COUPLING TEST. `findStaleConnections` (jobs/availability-cache.ts)
 * treats a connection as stale once `credential_checked_at` is older than
 * `STALENESS_CHECK_THRESHOLD_MS`, but under normal operation that column is refreshed only
 * once per `PROBE_INTERVAL_MS`. If a future change ever lowers `PROBE_INTERVAL_MS` to or
 * below the staleness threshold, `findStaleConnections` silently returns `[]` forever — the
 * exact permanent-no-op class round 1 closed for `last_synced_at`, re-armed by an unrelated
 * tuning change in a different file, with nothing else to catch it. This test fails the
 * instant that relationship inverts; `calendar-health-probe.ts` also asserts it at module
 * load, so the failure is loud in production too, not just in CI.
 */
describe('round-2 fix #8 — PROBE_INTERVAL_MS / STALENESS_CHECK_THRESHOLD_MS coupling', () => {
  it('keeps PROBE_INTERVAL_MS strictly greater than STALENESS_CHECK_THRESHOLD_MS', () => {
    expect(PROBE_INTERVAL_MS).toBeGreaterThan(STALENESS_CHECK_THRESHOLD_MS);
  });
});

describe('runCalendarHealthProbe', () => {
  it('is a no-op with zero candidates', async () => {
    mockListConnectionsDueForHealthCheck.mockResolvedValue([]);

    const result = await runCalendarHealthProbe(NOW);

    expect(result).toEqual({
      probed: 0,
      failed: 0,
      unclassifiedFailed: 0,
      recovered: 0,
      batchFilled: false,
      massFailureSuspected: false,
    });
    expect(mockCalendarsListGet).not.toHaveBeenCalled();
  });

  it('uses a CHEAP DATA CALL (calendars.list, pageSize: 1) — never a status-only read', async () => {
    mockListConnectionsDueForHealthCheck.mockResolvedValue([makeConnection()]);
    mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });

    await runCalendarHealthProbe(NOW);

    expect(mockCalendarsListGet).toHaveBeenCalledWith('eua-1', { pageSize: 1 });
    expect(mockMarkCredentialChecked).toHaveBeenCalledWith('conn-1', NOW);
  });

  it('warns when the batch fills — no silent caps', async () => {
    const candidates = Array.from({ length: CALENDAR_HEALTH_PROBE_BATCH_LIMIT }, (_, i) =>
      makeConnection({ id: `conn-${i}`, expertProfileId: `expert-${i}` })
    );
    mockListConnectionsDueForHealthCheck.mockResolvedValue(candidates);
    mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });

    const result = await runCalendarHealthProbe(NOW);

    expect(result.batchFilled).toBe(true);
    expect(mockLog.warn).toHaveBeenCalledWith(
      { limit: CALENDAR_HEALTH_PROBE_BATCH_LIMIT },
      expect.stringContaining('batch_filled')
    );
  });

  describe('the ticket’s named mandatory test — a dead credential is caught BY THE PROBE, not by a booking attempt', () => {
    it('a connection whose calendars.list fails ends the tick EXPIRED, notified, with the write DEFERRED to applyCredentialFailure', async () => {
      const connection = makeConnection({ credentialStatus: 'ACTIVE' });
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockRejectedValue(
        new MockApirocError({
          kind: 'unauthorized',
          status: 401,
          wireMessage: 'Token has been expired or revoked.',
        })
      );

      const result = await runCalendarHealthProbe(NOW);

      // ⚠ THE PROBE NEVER TOUCHES THE BOOKING PATH AT ALL — this module imports no booking
      // code (`isWindowAvailableForExpert` is not even a transitive import of this file), so
      // "zero calls to the booking gate" holds by construction, not by an assertion on a
      // module this file cannot reach.
      expect(result).toEqual({
        probed: 1,
        failed: 1,
        unclassifiedFailed: 0,
        recovered: 0,
        batchFilled: false,
        massFailureSuspected: false,
      });
      // ⚠ THE ONE PLACE A CREDENTIAL IS MARKED BROKEN — the write is DELEGATED, not
      // duplicated: this job never calls `setCredentialStatus` itself on the failure path.
      expect(mockApplyCredentialFailure).toHaveBeenCalledWith(
        connection,
        expect.any(MockApirocError),
        'health_probe'
      );
      expect(mockSetCredentialStatus).not.toHaveBeenCalled();
      // BAL-468 §8.4 — the reconcile enqueue fires on a SUCCESS branch, never on a failure one.
      expect(mockEnqueueSubscriptionReconcile).not.toHaveBeenCalled();
      // ⚠⚠ BAL-396 FIX ROUND — A FAILED DATA CALL IS STILL STAMPED AS AN ATTEMPT. This is the
      // probe's SCAN KEY (`listConnectionsDueForHealthCheck`'s `ORDER BY ... NULLS FIRST`),
      // not evidence the credential works — skipping the stamp on failure is exactly what
      // used to sort a permanently-dead connection FIRST forever and starve every healthy
      // connection out of the batch.
      expect(mockMarkCredentialChecked).toHaveBeenCalledWith('conn-1', NOW);
    });

    it('a 403 with the reconnect marker is ALSO reconnect_required — both status class arms reach applyCredentialFailure', async () => {
      const connection = makeConnection();
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockRejectedValue(
        new MockApirocError({
          kind: 'forbidden',
          status: 403,
          wireMessage: 'End user account credential expired',
        })
      );

      // The default mock's `classifyCredentialFailure` only recognises the 401 marker, so
      // override it here to prove the job code itself branches on `verdict.kind`, not on
      // status code — the classifier owns that judgement, this file just obeys it.
      mockClassifyCredentialFailure.mockReturnValueOnce({
        kind: 'reconnect_required',
        marker: 'End user account credential expired',
      });

      const result = await runCalendarHealthProbe(NOW);

      expect(result.failed).toBe(1);
      expect(mockApplyCredentialFailure).toHaveBeenCalledWith(
        connection,
        expect.any(MockApirocError),
        'health_probe'
      );
    });
  });

  describe('the healer — a probe success flips a broken connection back to ACTIVE', () => {
    it('SYNC_PENDING heals to ACTIVE via provisionConnection, rebuilds the cache, and fires SYNC_PENDING_AUTO_RESOLVED', async () => {
      const connection = makeConnection({ credentialStatus: 'SYNC_PENDING' });
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });
      mockProvisionConnection.mockResolvedValue('ACTIVE');

      const result = await runCalendarHealthProbe(NOW);

      expect(result.recovered).toBe(1);
      expect(mockProvisionConnection).toHaveBeenCalledWith(connection);
      // ⚠ NO SEPARATE `setCredentialStatus` CALL — `provisionConnection` already wrote ACTIVE
      // (and cleared `reconnectNotifiedAt` internally). A second write here would be the bug
      // this ticket's warning calls out explicitly.
      expect(mockSetCredentialStatus).not.toHaveBeenCalled();
      expect(mockEnqueueAvailabilityCacheRebuild).toHaveBeenCalledWith(
        connection.expertProfileId,
        expect.anything()
      );
      expect(mockTrackServer).toHaveBeenCalledWith('calendar_sync_pending_auto_resolved', {
        distinct_id: connection.expertProfileId,
      });
      // BAL-468 §8.4 — reprovision-heal branch, force: false (the desired set just changed).
      expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledWith(
        connection.id,
        { force: false },
        expect.anything()
      );
    });

    it('a SYNC_PENDING connection whose re-provision ALSO fails stays SYNC_PENDING this tick — no false recovery', async () => {
      const connection = makeConnection({ credentialStatus: 'SYNC_PENDING' });
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });
      mockProvisionConnection.mockResolvedValue('SYNC_PENDING');

      const result = await runCalendarHealthProbe(NOW);

      expect(result.recovered).toBe(0);
      expect(mockEnqueueAvailabilityCacheRebuild).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
      expect(mockEnqueueSubscriptionReconcile).not.toHaveBeenCalled();
    });

    it('EXPIRED heals to ACTIVE directly — reconnected out of band — and fires RECONNECT_RESOLVED', async () => {
      const connection = makeConnection({ credentialStatus: 'EXPIRED' });
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });

      const result = await runCalendarHealthProbe(NOW);

      expect(result.recovered).toBe(1);
      expect(mockSetCredentialStatus).toHaveBeenCalledWith('conn-1', 'ACTIVE');
      expect(mockEnqueueAvailabilityCacheRebuild).toHaveBeenCalledWith(
        connection.expertProfileId,
        expect.anything()
      );
      expect(mockTrackServer).toHaveBeenCalledWith('calendar_reconnect_resolved', {
        provider: 'google',
        distinct_id: connection.expertProfileId,
      });
      // BAL-468 §8.4/§8.6 — out-of-band-reconnect branch, force: true.
      expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledWith(
        connection.id,
        { force: true },
        expect.anything()
      );
    });

    it('an ACTIVE connection whose probe succeeds is left alone — not recovered, but STILL enqueues the maintenance sweep', async () => {
      const connection = makeConnection({ credentialStatus: 'ACTIVE' });
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });

      const result = await runCalendarHealthProbe(NOW);

      expect(result.recovered).toBe(0);
      expect(mockSetCredentialStatus).not.toHaveBeenCalled();
      expect(mockEnqueueAvailabilityCacheRebuild).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
      // BAL-468 §8.4 — ordinary already-healthy ACTIVE branch, force: false. The probe's proven
      // batch-bounded scheduler now also drives the subscription maintenance sweep.
      expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledWith(
        connection.id,
        { force: false },
        expect.anything()
      );
    });

    /**
     * ⚠⚠ BAL-396 FIX ROUND — THE "ACTIVE BUT UNREADABLE" ABSORBING STATE. Before this fix,
     * `provisionConnection` could persist `ACTIVE` with ZERO sub-calendar rows (a
     * `calendars.list` success with no writable calendars), and NOTHING in this file would
     * ever touch it again: `probeAndHeal` only re-provisioned a non-ACTIVE connection, and no
     * `calendar.auth_error` is published for a connection whose status reads ACTIVE. The
     * booking gate would fail CLOSED on it forever. Checking sub-calendar presence for an
     * ACTIVE connection closes that gap.
     */
    /**
     * ⚠⚠ round-2 fix #12 — this connection was `ACTIVE`, never `SYNC_PENDING`, so it must NOT
     * fire `SYNC_PENDING_AUTO_RESOLVED` — that metric no longer means what its name says if it
     * does. Pre-fix this test asserted the opposite (`calendar_sync_pending_auto_resolved`
     * WAS fired here); it now asserts the honestly-named log line instead.
     */
    it('an ACTIVE connection with ZERO sub-calendar rows is re-provisioned — the absorbing-state fix — and does NOT fire SYNC_PENDING_AUTO_RESOLVED', async () => {
      const connection = makeConnection({ credentialStatus: 'ACTIVE' });
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });
      mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
      mockProvisionConnection.mockResolvedValue('ACTIVE');

      const result = await runCalendarHealthProbe(NOW);

      expect(result.recovered).toBe(1);
      expect(mockFindSubCalendarsByConnectionId).toHaveBeenCalledWith('conn-1');
      expect(mockProvisionConnection).toHaveBeenCalledWith(connection);
      expect(mockEnqueueAvailabilityCacheRebuild).toHaveBeenCalledWith(
        connection.expertProfileId,
        expect.anything()
      );
      expect(mockTrackServer).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        { connectionId: 'conn-1', expertProfileId: connection.expertProfileId },
        'apiroc_active_zero_calendars_healed'
      );
      expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledWith(
        connection.id,
        { force: false },
        expect.anything()
      );
    });

    it('an ACTIVE connection with ZERO sub-calendar rows whose re-provision ALSO fails is left ACTIVE this tick — no false recovery', async () => {
      const connection = makeConnection({ credentialStatus: 'ACTIVE' });
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockResolvedValue({ data: [], nextPageToken: undefined });
      mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
      mockProvisionConnection.mockResolvedValue('SYNC_PENDING');

      const result = await runCalendarHealthProbe(NOW);

      expect(result.recovered).toBe(0);
      expect(mockEnqueueAvailabilityCacheRebuild).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
    });
  });

  describe('the mass-failure circuit breaker — flip nothing, notify nobody', () => {
    it('suspends every write when the reconnect-required share crosses the breaker', async () => {
      // 6 candidates, 5 reconnect_required ⇒ ratio 0.833 ≥ max(5, 0.5*6=3) ⇒ breaker fires.
      const candidates = Array.from({ length: 6 }, (_, i) =>
        makeConnection({ id: `conn-${i}`, expertProfileId: `expert-${i}` })
      );
      mockListConnectionsDueForHealthCheck.mockResolvedValue(candidates);
      // The job's loop is SERIAL (house precedent — see the file docblock), so keying the
      // failure decision off call ORDER is reliable: every candidate here shares the same
      // `endUserAccountId` fixture value, which order-based keying sidesteps entirely.
      let callIndex = 0;
      mockCalendarsListGet.mockImplementation(() => {
        const shouldFail = callIndex < 5;
        callIndex += 1;
        return shouldFail
          ? Promise.reject(
              new MockApirocError({
                kind: 'unauthorized',
                status: 401,
                wireMessage: 'Token has been expired or revoked.',
              })
            )
          : Promise.resolve({ data: [], nextPageToken: undefined });
      });

      const result = await runCalendarHealthProbe(NOW);

      expect(result.massFailureSuspected).toBe(true);
      expect(result.failed).toBe(0);
      expect(mockApplyCredentialFailure).not.toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ probed: 6, reconnectRequiredCount: 5 }),
        'apiroc_probe_mass_failure_suspected'
      );
    });

    it('applies failures normally when the reconnect-required share stays under the breaker', async () => {
      // 10 candidates, 1 reconnect_required ⇒ well under max(5, 0.5*10=5).
      const candidates = Array.from({ length: 10 }, (_, i) =>
        makeConnection({ id: `conn-${i}`, expertProfileId: `expert-${i}` })
      );
      mockListConnectionsDueForHealthCheck.mockResolvedValue(candidates);
      let callIndex = 0;
      mockCalendarsListGet.mockImplementation(() => {
        const isFirst = callIndex === 0;
        callIndex += 1;
        return isFirst
          ? Promise.reject(
              new MockApirocError({
                kind: 'unauthorized',
                status: 401,
                wireMessage: 'Token has been expired or revoked.',
              })
            )
          : Promise.resolve({ data: [], nextPageToken: undefined });
      });

      const result = await runCalendarHealthProbe(NOW);

      expect(result.massFailureSuspected).toBe(false);
      expect(result.failed).toBe(1);
      expect(mockApplyCredentialFailure).toHaveBeenCalledTimes(1);
      expect(mockApplyCredentialFailure).toHaveBeenCalledWith(
        candidates[0],
        expect.any(MockApirocError),
        'health_probe'
      );
    });

    /**
     * ⚠⚠ round-2 fix #7 — THE SMALL-FLEET REGRESSION TEST. Pre-fix, `Math.max(5, 0.5 *
     * candidates.length)` never drops below 5, so 4 candidates ALL failing (`4 >= 5` false)
     * sailed straight through the breaker and got flipped EXPIRED, cache-cleared, and emailed
     * — for what is, on a uniform 100% failure with no successes at all, overwhelmingly more
     * likely a Balo-side platform-key fault than 4 independent expert-side revokes landing in
     * the same 15-minute probe window.
     */
    it('trips the breaker on a uniformly-failing SMALL fleet even though the ratio threshold is unreachable', async () => {
      const candidates = Array.from({ length: 4 }, (_, i) =>
        makeConnection({ id: `conn-${i}`, expertProfileId: `expert-${i}` })
      );
      mockListConnectionsDueForHealthCheck.mockResolvedValue(candidates);
      mockCalendarsListGet.mockRejectedValue(
        new MockApirocError({
          kind: 'unauthorized',
          status: 401,
          wireMessage: 'Token has been expired or revoked.',
        })
      );

      const result = await runCalendarHealthProbe(NOW);

      expect(result.massFailureSuspected).toBe(true);
      expect(result.failed).toBe(0);
      expect(result.unclassifiedFailed).toBe(0);
      expect(mockApplyCredentialFailure).not.toHaveBeenCalled();
      expect(mockSetCredentialStatus).not.toHaveBeenCalled();
    });

    it('does NOT trip the breaker for a single failing connection — one revoke is an ordinary event', async () => {
      const connection = makeConnection();
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockRejectedValue(
        new MockApirocError({
          kind: 'unauthorized',
          status: 401,
          wireMessage: 'Token has been expired or revoked.',
        })
      );

      const result = await runCalendarHealthProbe(NOW);

      expect(result.massFailureSuspected).toBe(false);
      expect(result.failed).toBe(1);
      expect(mockApplyCredentialFailure).toHaveBeenCalledWith(
        connection,
        expect.any(MockApirocError),
        'health_probe'
      );
    });

    it('does NOT trip the uniform-failure gate when at least one candidate succeeds, even on a small fleet', async () => {
      const candidates = Array.from({ length: 4 }, (_, i) =>
        makeConnection({ id: `conn-${i}`, expertProfileId: `expert-${i}` })
      );
      mockListConnectionsDueForHealthCheck.mockResolvedValue(candidates);
      let callIndex = 0;
      mockCalendarsListGet.mockImplementation(() => {
        const isLast = callIndex === 3;
        callIndex += 1;
        return isLast
          ? Promise.resolve({ data: [], nextPageToken: undefined })
          : Promise.reject(
              new MockApirocError({
                kind: 'unauthorized',
                status: 401,
                wireMessage: 'Token has been expired or revoked.',
              })
            );
      });

      const result = await runCalendarHealthProbe(NOW);

      expect(result.massFailureSuspected).toBe(false);
      expect(result.failed).toBe(3);
      expect(mockApplyCredentialFailure).toHaveBeenCalledTimes(3);
    });
  });

  /**
   * ⚠⚠ BAL-396 FIX ROUND — THE MISSING TEST. Before this fix, only `reconnectRequired`
   * failures were routed through `applyCredentialFailure`, so `credential-status.ts`'s
   * `platform_auth_failure` / `transient` / `other` branches (including the
   * `apiroc_platform_auth_failure` marker) were UNREACHABLE in production — this job is that
   * function's only caller. `result.failed` also counted ONLY applied reconnect failures, so
   * a sweep where every call 401s on a bad PLATFORM key logged `failed: 0`, indistinguishable
   * from a genuinely healthy tick.
   */
  describe('non-reconnect verdicts still reach applyCredentialFailure — BAL-396 fix round', () => {
    it('platform_auth_failure is applied (never skipped) and counted as unclassifiedFailed, not failed', async () => {
      const connection = makeConnection();
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockRejectedValue(
        new MockApirocError({ kind: 'unauthorized', status: 401, wireMessage: 'bad api key' })
      );
      // The default mock's classifyCredentialFailure (see beforeEach) returns
      // `platform_auth_failure` for an 'unauthorized' kind that does not carry the reconnect
      // marker — exactly a bad platform API key, not a reconnect-required credential.

      const result = await runCalendarHealthProbe(NOW);

      expect(result.massFailureSuspected).toBe(false);
      expect(result.failed).toBe(0);
      expect(result.unclassifiedFailed).toBe(1);
      expect(mockApplyCredentialFailure).toHaveBeenCalledWith(
        connection,
        expect.any(MockApirocError),
        'health_probe'
      );
      // The scan-key stamp still happens — a platform-key fault must not starve this
      // connection out of every future batch either.
      expect(mockMarkCredentialChecked).toHaveBeenCalledWith('conn-1', NOW);
    });
  });

  describe('a non-ApirocError failure is logged and left alone — never misclassified', () => {
    it('logs apiroc_health_probe_unexpected_error and does not call applyCredentialFailure', async () => {
      const connection = makeConnection();
      mockListConnectionsDueForHealthCheck.mockResolvedValue([connection]);
      mockCalendarsListGet.mockRejectedValue(new Error('totally unrelated crash'));

      const result = await runCalendarHealthProbe(NOW);

      expect(result.failed).toBe(0);
      expect(mockApplyCredentialFailure).not.toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'conn-1' }),
        'apiroc_health_probe_unexpected_error'
      );
    });
  });
});
