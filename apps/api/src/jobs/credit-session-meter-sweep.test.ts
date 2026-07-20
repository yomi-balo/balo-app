import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';

const {
  mockFindMeterable,
  mockFindWrappedIdle,
  mockFindStalePending,
  mockFindStuckSettling,
  mockFindFinalizedMissingPayout,
  mockCancel,
  mockDriveSession,
  mockEndSession,
  mockReconcile,
  mockFinalizeBilling,
} = vi.hoisted(() => ({
  mockFindMeterable: vi.fn(),
  mockFindWrappedIdle: vi.fn(),
  mockFindStalePending: vi.fn(),
  mockFindStuckSettling: vi.fn(),
  mockFindFinalizedMissingPayout: vi.fn(),
  mockCancel: vi.fn(),
  mockDriveSession: vi.fn(),
  mockEndSession: vi.fn(),
  mockReconcile: vi.fn(),
  mockFinalizeBilling: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findMeterable: mockFindMeterable,
    findWrappedIdle: mockFindWrappedIdle,
    findStalePending: mockFindStalePending,
    findStuckSettling: mockFindStuckSettling,
    findFinalizedMissingPayout: mockFindFinalizedMissingPayout,
    cancel: mockCancel,
  },
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn() }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn() }));
vi.mock('../services/credit-session/index.js', () => ({
  driveSession: mockDriveSession,
  endSessionAsSystem: mockEndSession,
  reconcileStuckSettlement: mockReconcile,
  finalizeBilling: mockFinalizeBilling,
}));

import { runSessionMeterSweep } from './credit-session-meter-sweep.js';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session_1',
    status: 'active',
    initiatingMemberId: 'user_1',
    connectedAt: new Date(NOW.getTime() - 5 * 60_000),
    ...overrides,
  };
}

describe('runSessionMeterSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMeterable.mockResolvedValue([]);
    mockFindWrappedIdle.mockResolvedValue([]);
    mockFindStalePending.mockResolvedValue([]);
    mockFindStuckSettling.mockResolvedValue([]);
    mockFindFinalizedMissingPayout.mockResolvedValue([]);
    mockDriveSession.mockImplementation(async (id: string) => ({
      session: activeSession({ id }),
      transitions: {},
      ticksPosted: 0,
    }));
  });

  it('meters every meterable session', async () => {
    mockFindMeterable.mockResolvedValue([activeSession({ id: 's1' }), activeSession({ id: 's2' })]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockDriveSession).toHaveBeenCalledTimes(2);
    expect(result.metered).toBe(2);
  });

  it('force-ends a session past MAX_SESSION_MINUTES', async () => {
    const stale = activeSession({
      connectedAt: new Date(NOW.getTime() - (MAX_SESSION_MINUTES + 1) * 60_000),
    });
    mockFindMeterable.mockResolvedValue([stale]);
    mockDriveSession.mockResolvedValue({ session: stale, transitions: {}, ticksPosted: 0 });
    await runSessionMeterSweep(NOW);
    expect(mockEndSession).toHaveBeenCalledWith('session_1', { now: NOW });
  });

  it('does not force-end a session within the cap', async () => {
    mockFindMeterable.mockResolvedValue([activeSession()]);
    await runSessionMeterSweep(NOW);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('auto-ends wrapped-idle sessions', async () => {
    mockFindWrappedIdle.mockResolvedValue([activeSession({ status: 'wrapped' })]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockEndSession).toHaveBeenCalledWith('session_1', { now: NOW });
    expect(result.ended).toBe(1);
  });

  it('auto-cancels stale-pending sessions', async () => {
    mockFindStalePending.mockResolvedValue([activeSession({ status: 'pending' })]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockCancel).toHaveBeenCalledWith('session_1');
    expect(result.cancelled).toBe(1);
  });

  it('reconciles stuck settlements', async () => {
    const stuck = activeSession({ status: 'ended', settlementStatus: 'processing' });
    mockFindStuckSettling.mockResolvedValue([stuck]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockReconcile).toHaveBeenCalledWith(stuck, { now: NOW });
    expect(result.reconciled).toBe(1);
  });

  it('isolates a per-row meter failure (batch continues)', async () => {
    mockFindMeterable.mockResolvedValue([activeSession({ id: 's1' }), activeSession({ id: 's2' })]);
    mockDriveSession.mockRejectedValueOnce(new Error('boom'));
    mockDriveSession.mockResolvedValueOnce({
      session: activeSession({ id: 's2' }),
      transitions: {},
      ticksPosted: 0,
    });
    const result = await runSessionMeterSweep(NOW);
    // s1 threw, s2 succeeded — the sweep does not abort.
    expect(result.metered).toBe(1);
  });

  // BAL-399 pass 5 — reconcile finalized sessions with no payout obligation booked.
  it('reconciles a stranded finalized session by replaying finalizeBilling with the persisted path', async () => {
    const stranded = activeSession({
      status: 'ended',
      billingFinalizedAt: new Date(NOW.getTime() - 10 * 60_000),
      finalizationPath: 'confirmed',
    });
    mockFindFinalizedMissingPayout.mockResolvedValue([stranded]);
    const result = await runSessionMeterSweep(NOW);
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(1);
    expect(mockFinalizeBilling).toHaveBeenCalledWith(stranded, 'confirmed', NOW);
    expect(result.recovered).toBe(1);
    // The reconcile books the payout — it never re-drives the meter or re-settles.
    expect(mockDriveSession).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('defaults a null finalizationPath to live_capture on replay', async () => {
    const stranded = activeSession({
      status: 'ended',
      billingFinalizedAt: new Date(NOW.getTime() - 10 * 60_000),
      finalizationPath: null,
    });
    mockFindFinalizedMissingPayout.mockResolvedValue([stranded]);
    await runSessionMeterSweep(NOW);
    expect(mockFinalizeBilling).toHaveBeenCalledWith(stranded, 'live_capture', NOW);
  });

  it('is a no-op once the obligation is booked (finder returns nothing on the next sweep)', async () => {
    // First sweep recovers; the anti-join then no longer returns the row (payout now exists).
    mockFindFinalizedMissingPayout.mockResolvedValueOnce([
      activeSession({ id: 's1', status: 'ended', finalizationPath: 'live_capture' }),
    ]);
    mockFindFinalizedMissingPayout.mockResolvedValueOnce([]);
    const first = await runSessionMeterSweep(NOW);
    const second = await runSessionMeterSweep(NOW);
    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(1);
  });

  it('isolates a per-row finalizeBilling failure (batch continues, sweep does not abort)', async () => {
    mockFindFinalizedMissingPayout.mockResolvedValue([
      activeSession({ id: 's1', status: 'ended', finalizationPath: 'live_capture' }),
      activeSession({ id: 's2', status: 'ended', finalizationPath: 'live_capture' }),
    ]);
    mockFinalizeBilling.mockRejectedValueOnce(new Error('record failed'));
    mockFinalizeBilling.mockResolvedValueOnce(undefined);
    const result = await runSessionMeterSweep(NOW);
    expect(mockFinalizeBilling).toHaveBeenCalledTimes(2); // both attempted
    expect(result.recovered).toBe(1); // s1 threw, s2 recovered
  });
});
