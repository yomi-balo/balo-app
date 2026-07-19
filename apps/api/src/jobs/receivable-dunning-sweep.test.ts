import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockListOpenForDunning, mockMarkDunned, mockPublishSettlementFailure } = vi.hoisted(() => ({
  mockListOpenForDunning: vi.fn(),
  mockMarkDunned: vi.fn(),
  mockPublishSettlementFailure: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditReceivablesRepository: {
    listOpenForDunning: mockListOpenForDunning,
    markDunned: mockMarkDunned,
  },
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn() }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn() }));
vi.mock('../services/credit-session/notify.js', () => ({
  publishSettlementFailure: mockPublishSettlementFailure,
}));

import { runReceivableDunningSweep } from './receivable-dunning-sweep.js';

const NOW = new Date('2026-07-16T09:00:00.000Z');

function receivable(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec_1',
    sessionId: 'session_1',
    companyId: 'company_1',
    walletId: 'wallet_1',
    amountMinor: 1200,
    reason: 'settlement_declined',
    ...overrides,
  };
}

describe('runReceivableDunningSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListOpenForDunning.mockResolvedValue([]);
  });

  it('re-notifies + stamps each open receivable', async () => {
    mockListOpenForDunning.mockResolvedValue([receivable()]);
    const result = await runReceivableDunningSweep(NOW);
    expect(mockPublishSettlementFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { id: 'session_1', companyId: 'company_1', walletId: 'wallet_1' },
        reason: 'declined',
        amountMinor: 1200,
        attemptEpochMs: NOW.getTime(),
      })
    );
    expect(mockMarkDunned).toHaveBeenCalledWith('rec_1', NOW);
    expect(result.dunned).toBe(1);
  });

  it('maps a requires_action receivable reason', async () => {
    mockListOpenForDunning.mockResolvedValue([
      receivable({ reason: 'settlement_requires_action' }),
    ]);
    await runReceivableDunningSweep(NOW);
    expect(mockPublishSettlementFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'requires_action' })
    );
  });

  it('queries with a sub-24h cadence window', async () => {
    await runReceivableDunningSweep(NOW);
    const [notDunnedSince] = mockListOpenForDunning.mock.calls[0] as [Date];
    expect(NOW.getTime() - notDunnedSince.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
    expect(NOW.getTime() - notDunnedSince.getTime()).toBeGreaterThan(0);
  });

  it('isolates a per-row failure (batch continues)', async () => {
    mockListOpenForDunning.mockResolvedValue([
      receivable({ id: 'rec_1' }),
      receivable({ id: 'rec_2' }),
    ]);
    mockPublishSettlementFailure.mockRejectedValueOnce(new Error('boom'));
    const result = await runReceivableDunningSweep(NOW);
    expect(result.dunned).toBe(1);
  });
});
