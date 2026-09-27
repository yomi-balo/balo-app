import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockListWalletsDue, mockPublishHoldDunningNotice, mockLoggerWarn, mockLoggerError } =
  vi.hoisted(() => ({
    mockListWalletsDue: vi.fn(),
    mockPublishHoldDunningNotice: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));
vi.mock('@balo/db', () => ({
  creditReceivablesRepository: {
    listWalletsDueForDailyDunning: mockListWalletsDue,
  },
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn() }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn() }));
// BAL-474 — the sweep imports the cadence from `notify.ts` (no service → jobs import, no cycle) and
// hands each due wallet to the wallet-grain publisher. Both come from the one mocked module.
vi.mock('../services/credit-session/notify.js', () => ({
  DUNNING_CADENCE_HOURS: 20,
  publishHoldDunningNotice: mockPublishHoldDunningNotice,
}));

import { runReceivableDunningSweep } from './receivable-dunning-sweep.js';

const NOW = new Date('2026-07-16T09:00:00.000Z');

function wallet(id: string) {
  return { walletId: id, companyId: `company_of_${id}` };
}

describe('runReceivableDunningSweep (BAL-474 — wallet grain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListWalletsDue.mockResolvedValue([]);
    mockPublishHoldDunningNotice.mockResolvedValue('published');
  });

  it('hands each due WALLET to the wallet-grain publisher on the daily arm, keyed per write', async () => {
    mockListWalletsDue.mockResolvedValue([wallet('wallet_1')]);

    const result = await runReceivableDunningSweep(NOW);

    expect(mockPublishHoldDunningNotice).toHaveBeenCalledTimes(1);
    expect(mockPublishHoldDunningNotice).toHaveBeenCalledWith({
      walletId: 'wallet_1',
      companyId: 'company_of_wallet_1',
      trigger: 'daily_reminder',
      correlationKey: `wallet_1:${String(NOW.getTime())}`,
      now: NOW,
    });
    expect(result.dunned).toBe(1);
  });

  it('one notice per wallet — never one per receivable', async () => {
    mockListWalletsDue.mockResolvedValue([wallet('wallet_1'), wallet('wallet_2')]);
    const result = await runReceivableDunningSweep(NOW);
    expect(mockPublishHoldDunningNotice).toHaveBeenCalledTimes(2);
    expect(result.dunned).toBe(2);
  });

  it('queries with a sub-24h cadence window (the cadence constant lives in notify.ts) and an EXPLICIT limit', async () => {
    await runReceivableDunningSweep(NOW);
    const [notRemindedSince, limit] = mockListWalletsDue.mock.calls[0] as [Date, number];
    expect(NOW.getTime() - notRemindedSince.getTime()).toBe(20 * 60 * 60 * 1000);
    expect(NOW.getTime() - notRemindedSince.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
    expect(limit).toBe(100);
  });

  it('isolates a per-wallet failure (batch continues) and logs it with the wallet id', async () => {
    mockListWalletsDue.mockResolvedValue([wallet('wallet_1'), wallet('wallet_2')]);
    const failure = new Error('boom');
    mockPublishHoldDunningNotice.mockRejectedValueOnce(failure);
    const logged: string[] = [];

    const result = await runReceivableDunningSweep(NOW, (message) => logged.push(message));

    expect(result.dunned).toBe(1);
    expect(mockPublishHoldDunningNotice).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).toHaveBeenCalledWith(
      { walletId: 'wallet_1', error: 'boom', stack: failure.stack },
      'Wallet dunning failed'
    );
    expect(logged).toEqual(['dunning failed for wallet wallet_1: boom']);
  });

  it('warns when the batch FILLS — due wallets were left for the next sweep (no silent cap)', async () => {
    mockListWalletsDue.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => wallet(`wallet_${String(index)}`))
    );
    await runReceivableDunningSweep(NOW);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { limit: 100 },
      expect.stringContaining('Dunning batch FILLED')
    );
  });

  it('a batch under the limit does not warn', async () => {
    mockListWalletsDue.mockResolvedValue([wallet('wallet_1')]);
    await runReceivableDunningSweep(NOW);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('⚠ counts ONLY the notices actually published — a heal, a lost race and a no-longer-held wallet are not "dunned"', async () => {
    mockListWalletsDue.mockResolvedValue([
      wallet('published'),
      wallet('healed'),
      wallet('already'),
      wallet('not_on_hold'),
      wallet('publish_failed'),
    ]);
    mockPublishHoldDunningNotice
      .mockResolvedValueOnce('published')
      .mockResolvedValueOnce('healed')
      .mockResolvedValueOnce('already_reminded')
      .mockResolvedValueOnce('not_on_hold')
      .mockResolvedValueOnce('publish_failed');

    const result = await runReceivableDunningSweep(NOW);

    expect(result).toEqual({ dunned: 1, healed: 1 });
  });

  it('does nothing when no wallet is due', async () => {
    const result = await runReceivableDunningSweep(NOW);
    expect(mockPublishHoldDunningNotice).not.toHaveBeenCalled();
    expect(result.dunned).toBe(0);
  });
});
