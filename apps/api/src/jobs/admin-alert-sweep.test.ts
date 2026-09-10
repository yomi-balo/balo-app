import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * BAL-548 / ADR-1055 — unit coverage for the sweep body (`runAdminAlertSweep`), which is
 * exported precisely so it can be exercised without a Redis-backed Worker.
 *
 * The REGISTRY (`@balo/shared/admin-alerts`) is real, not mocked — it is pure data, and
 * mocking it would just re-type the fixture the test is trying to prove correct. What IS
 * mocked: `@balo/db` (the repository calls), the logger (ONE STABLE instance, asserted on),
 * and `./admin-alert-finders.js` (the actual finder implementations — this suite is about the
 * sweep's ORCHESTRATION, not what any one finder returns).
 */

const { mockReconcileKind, mockRaise, mockMarkTick, mockLog } = vi.hoisted(() => ({
  mockReconcileKind: vi.fn(),
  mockRaise: vi.fn(),
  mockMarkTick: vi.fn(),
  /** ONE STABLE logger instance — every call site shares it, so `.mock.calls` is the whole story. */
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('@balo/db', () => ({
  adminAlertsRepository: {
    reconcileKind: mockReconcileKind,
    raise: mockRaise,
  },
  adminSweepTicksRepository: {
    markTick: mockMarkTick,
  },
}));

const {
  mockExpertApplicationPending,
  mockReceivableOpen,
  mockSessionSettledNoLedgerCredit,
  mockRecordingFailed,
  mockTranscriptFailed,
  mockTranscriptCaptureWithheldSource,
  mockCalendarSubscriptionLapse,
} = vi.hoisted(() => ({
  mockExpertApplicationPending: vi.fn(),
  mockReceivableOpen: vi.fn(),
  mockSessionSettledNoLedgerCredit: vi.fn(),
  mockRecordingFailed: vi.fn(),
  mockTranscriptFailed: vi.fn(),
  mockTranscriptCaptureWithheldSource: vi.fn(),
  mockCalendarSubscriptionLapse: vi.fn(),
}));

vi.mock('./admin-alert-finders.js', () => ({
  ADMIN_ALERT_FINDERS: {
    expertApplicationPending: mockExpertApplicationPending,
    receivableOpen: mockReceivableOpen,
    sessionSettledNoLedgerCredit: mockSessionSettledNoLedgerCredit,
    recordingFailed: mockRecordingFailed,
    transcriptFailed: mockTranscriptFailed,
    transcriptCaptureWithheldSource: mockTranscriptCaptureWithheldSource,
    calendarSubscriptionLapse: mockCalendarSubscriptionLapse,
  },
}));

vi.mock('bullmq', () => ({
  Worker: class {},
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: vi.fn() }) }));

import { runAdminAlertSweep } from './admin-alert-sweep.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');

const EMPTY_OUTCOME = { findings: [], batchFilled: false };
const EMPTY_RECONCILE_RESULT = { inserted: 0, bumped: 0, resolved: 0, stormed: false, found: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [
    mockExpertApplicationPending,
    mockReceivableOpen,
    mockSessionSettledNoLedgerCredit,
    mockRecordingFailed,
    mockTranscriptFailed,
    mockTranscriptCaptureWithheldSource,
    mockCalendarSubscriptionLapse,
  ]) {
    mock.mockResolvedValue(EMPTY_OUTCOME);
  }
  mockReconcileKind.mockResolvedValue(EMPTY_RECONCILE_RESULT);
  mockRaise.mockResolvedValue({});
  mockMarkTick.mockResolvedValue(undefined);
});

describe('runAdminAlertSweep', () => {
  it('calls reconcileKind once per kind for the 1m cadence and never for another cadence', async () => {
    await runAdminAlertSweep('1m', NOW);

    expect(mockExpertApplicationPending).toHaveBeenCalledTimes(1);
    expect(mockReceivableOpen).toHaveBeenCalledTimes(1);
    expect(mockSessionSettledNoLedgerCredit).toHaveBeenCalledTimes(1);
    // 5m / 15m finders never called on a 1m tick.
    expect(mockRecordingFailed).not.toHaveBeenCalled();
    expect(mockTranscriptFailed).not.toHaveBeenCalled();
    expect(mockTranscriptCaptureWithheldSource).not.toHaveBeenCalled();
    expect(mockCalendarSubscriptionLapse).not.toHaveBeenCalled();

    expect(mockReconcileKind).toHaveBeenCalledTimes(3);
    const kindsCalled = mockReconcileKind.mock.calls.map(([input]) => input.kind);
    expect(new Set(kindsCalled)).toEqual(
      new Set(['expert.application_pending', 'receivable.open', 'session.settled_no_ledger_credit'])
    );
  });

  it('calls reconcileKind once per kind for the 5m cadence', async () => {
    await runAdminAlertSweep('5m', NOW);
    expect(mockRecordingFailed).toHaveBeenCalledTimes(1);
    expect(mockTranscriptFailed).toHaveBeenCalledTimes(1);
    expect(mockTranscriptCaptureWithheldSource).toHaveBeenCalledTimes(1);
    expect(mockReconcileKind).toHaveBeenCalledTimes(3);
    expect(mockExpertApplicationPending).not.toHaveBeenCalled();
    expect(mockCalendarSubscriptionLapse).not.toHaveBeenCalled();
  });

  it('calls reconcileKind once for the 15m cadence', async () => {
    await runAdminAlertSweep('15m', NOW);
    expect(mockCalendarSubscriptionLapse).toHaveBeenCalledTimes(1);
    expect(mockReconcileKind).toHaveBeenCalledTimes(1);
    expect(mockReconcileKind.mock.calls[0]?.[0].kind).toBe('calendar.subscription_lapse');
  });

  it('threads the storm/sentinel constants through to reconcileKind unchanged', async () => {
    await runAdminAlertSweep('1m', NOW);
    for (const [input] of mockReconcileKind.mock.calls) {
      expect(input.stormThreshold).toBe(25);
      expect(input.stormSampleLimit).toBe(10);
      expect(input.stormKind).toBe(`${input.kind}.storm`);
      expect(input.sentinelEntityId).toBe('00000000-0000-4000-8000-000000005548');
      expect(input.now).toBe(NOW);
    }
  });

  it('a throwing finder does not abort the tick, and other kinds still reconcile', async () => {
    mockReceivableOpen.mockRejectedValue(new Error('boom'));

    const result = await runAdminAlertSweep('1m', NOW);

    expect(result.failures).toBe(1);
    // The other two 1m kinds still reconciled.
    expect(mockReconcileKind).toHaveBeenCalledTimes(2);
    const kindsCalled = mockReconcileKind.mock.calls.map(([input]) => input.kind);
    expect(kindsCalled).not.toContain('receivable.open');
  });

  it('produces exactly ONE logger.error and ONE sweep.failed raise per tick regardless of how many finders threw', async () => {
    mockReceivableOpen.mockRejectedValue(new Error('boom 1'));
    mockExpertApplicationPending.mockRejectedValue(new Error('boom 2'));
    mockSessionSettledNoLedgerCredit.mockRejectedValue(new Error('boom 3'));

    const result = await runAdminAlertSweep('1m', NOW);

    expect(result.failures).toBe(3);
    const failureErrorCalls = mockLog.error.mock.calls.filter(([, msg]) =>
      String(msg).includes('admin_alert_sweep_finder_failed')
    );
    expect(failureErrorCalls).toHaveLength(1);
    expect(failureErrorCalls[0]?.[0].count).toBe(3);

    const sweepFailedRaises = mockRaise.mock.calls.filter(
      ([input]) => input.kind === 'sweep.failed'
    );
    expect(sweepFailedRaises).toHaveLength(1);
    expect(sweepFailedRaises[0]?.[0].entityType).toBe('sweep');
    expect(sweepFailedRaises[0]?.[0].entityId).toBe('00000000-0000-4000-8000-000000005548');
  });

  it('does not raise sweep.failed when nothing threw', async () => {
    await runAdminAlertSweep('1m', NOW);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  it('two filled batches produce exactly ONE logger.warn for the batch-filled record', async () => {
    mockReceivableOpen.mockResolvedValue({ findings: [], batchFilled: true });
    mockExpertApplicationPending.mockResolvedValue({ findings: [], batchFilled: true });

    await runAdminAlertSweep('1m', NOW);

    const batchFilledWarnings = mockLog.warn.mock.calls.filter(([, msg]) =>
      String(msg).includes('admin_alert_sweep_batch_filled')
    );
    expect(batchFilledWarnings).toHaveLength(1);
    expect(batchFilledWarnings[0]?.[0].arms).toHaveLength(2);
  });

  it('A-F2: threads batchFilled through to reconcileKind, per kind, unmixed with the un-filled kind', async () => {
    // ⚠ This suite mocks reconcileKind entirely, so it can only prove the ORCHESTRATION threads
    // the flag through correctly — never that the repository's resolve arm actually honours it.
    // That property is proven for real against Postgres in
    // `admin-alerts.integration.test.ts` (A-F2).
    mockReceivableOpen.mockResolvedValue({ findings: [], batchFilled: true });
    mockExpertApplicationPending.mockResolvedValue({ findings: [], batchFilled: false });

    await runAdminAlertSweep('1m', NOW);

    const calls = new Map(mockReconcileKind.mock.calls.map(([input]) => [input.kind, input]));
    expect(calls.get('receivable.open')?.batchFilled).toBe(true);
    expect(calls.get('expert.application_pending')?.batchFilled).toBe(false);
  });

  it('markTick is called even when a finder threw', async () => {
    mockReceivableOpen.mockRejectedValue(new Error('boom'));
    await runAdminAlertSweep('1m', NOW);
    expect(mockMarkTick).toHaveBeenCalledWith('1m', NOW);
  });

  it('a skipped feature_disabled kind calls reconcileKind zero times for that kind', async () => {
    mockCalendarSubscriptionLapse.mockResolvedValue({
      findings: [],
      batchFilled: false,
      skipped: 'feature_disabled',
    });

    await runAdminAlertSweep('15m', NOW);

    expect(mockReconcileKind).not.toHaveBeenCalled();
    const skipWarnings = mockLog.warn.mock.calls.filter(([, msg]) =>
      String(msg).includes('admin_alert_sweep_kind_skipped')
    );
    expect(skipWarnings).toHaveLength(1);
  });

  it('a failure raising sweep.failed is itself caught (never fails the tick)', async () => {
    mockReceivableOpen.mockRejectedValue(new Error('boom'));
    mockRaise.mockRejectedValue(new Error('db is down'));

    await expect(runAdminAlertSweep('1m', NOW)).resolves.not.toThrow();
    expect(mockMarkTick).toHaveBeenCalled();
  });

  it('aggregates inserted/bumped/resolved/stormed across kinds', async () => {
    mockReconcileKind
      .mockResolvedValueOnce({ inserted: 2, bumped: 1, resolved: 0, stormed: false, found: 3 })
      .mockResolvedValueOnce({ inserted: 0, bumped: 0, resolved: 1, stormed: false, found: 0 })
      .mockResolvedValueOnce({ inserted: 0, bumped: 0, resolved: 0, stormed: true, found: 30 });

    const result = await runAdminAlertSweep('1m', NOW);

    expect(result.inserted).toBe(2);
    expect(result.bumped).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.stormed).toBe(1);
  });
});
