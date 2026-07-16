import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const {
  mockFindExpiringBetween,
  mockFindExpirable,
  mockExpireDormant,
  mockPublish,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockFindExpiringBetween: vi.fn(),
  mockFindExpirable: vi.fn(),
  mockExpireDormant: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditWalletsRepository: {
    findWalletsExpiringBetween: mockFindExpiringBetween,
    findExpirableWallets: mockFindExpirable,
  },
  creditLedgerRepository: {
    expireDormantBalance: mockExpireDormant,
  },
}));

// `@balo/shared/pricing` is pure — use the real DORMANCY_REMINDER_WINDOWS_DAYS ([60, 30]).

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CREDIT_SERVER_EVENTS: {
    DORMANCY_REMINDER_SENT: 'credit_dormancy_reminder_sent',
    BALANCE_EXPIRED: 'credit_balance_expired',
    FX_CACHE_STALE: 'credit_fx_cache_stale',
  },
}));

vi.mock('../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock('bullmq', () => ({ Worker: class MockWorker {} }));

import {
  runWalletDormancySweep,
  WALLET_DORMANCY_SWEEP_CRON,
  WALLET_DORMANCY_SWEEP_QUEUE,
} from './wallet-dormancy-sweep.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-16T12:00:00Z');

function wallet(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'wallet-1',
    companyId: 'company-1',
    balanceMinor: 34700,
    expiresAt: new Date('2027-07-12T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindExpiringBetween.mockResolvedValue([]);
  mockFindExpirable.mockResolvedValue([]);
});

describe('runWalletDormancySweep — reminder band math (D2)', () => {
  it('queries the 60d + 30d half-open bands off absolute expires_at', async () => {
    await runWalletDormancySweep(NOW);

    expect(mockFindExpiringBetween).toHaveBeenCalledTimes(2);
    // Band 60: expires_at ∈ (now+59d, now+60d]
    expect(mockFindExpiringBetween.mock.calls[0]?.[0]).toEqual(
      new Date(NOW.getTime() + 59 * DAY_MS)
    );
    expect(mockFindExpiringBetween.mock.calls[0]?.[1]).toEqual(
      new Date(NOW.getTime() + 60 * DAY_MS)
    );
    // Band 30: expires_at ∈ (now+29d, now+30d]
    expect(mockFindExpiringBetween.mock.calls[1]?.[0]).toEqual(
      new Date(NOW.getTime() + 29 * DAY_MS)
    );
    expect(mockFindExpiringBetween.mock.calls[1]?.[1]).toEqual(
      new Date(NOW.getTime() + 30 * DAY_MS)
    );
  });
});

describe('runWalletDormancySweep — reminder publish + analytics (D3)', () => {
  it('publishes credit.dormancy_reminder with the (wallet, window, expiry-date) correlationId', async () => {
    mockFindExpiringBetween.mockResolvedValueOnce([wallet()]).mockResolvedValueOnce([]);

    const result = await runWalletDormancySweep(NOW);

    expect(result.reminders).toBe(1);
    expect(mockPublish).toHaveBeenCalledWith('credit.dormancy_reminder', {
      correlationId: 'wallet-1:dormancy_reminder:60:2027-07-12',
      walletId: 'wallet-1',
      companyId: 'company-1',
      window: 60,
      balanceMinor: 34700,
      expiresAt: '2027-07-12T00:00:00.000Z',
    });
    expect(mockTrackServer).toHaveBeenCalledWith('credit_dormancy_reminder_sent', {
      window: 60,
      company_id: 'company-1',
      wallet_id: 'wallet-1',
      distinct_id: 'company-1',
    });
  });

  it('uses the 30-day window for the second band', async () => {
    mockFindExpiringBetween
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([wallet({ id: 'wallet-2', companyId: 'company-2' })]);

    await runWalletDormancySweep(NOW);

    expect(mockPublish).toHaveBeenCalledWith(
      'credit.dormancy_reminder',
      expect.objectContaining({
        correlationId: 'wallet-2:dormancy_reminder:30:2027-07-12',
        window: 30,
      })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'credit_dormancy_reminder_sent',
      expect.objectContaining({ window: 30, wallet_id: 'wallet-2' })
    );
  });

  it('skips a wallet whose expires_at is null (defensive) without counting it', async () => {
    mockFindExpiringBetween
      .mockResolvedValueOnce([wallet({ expiresAt: null })])
      .mockResolvedValueOnce([]);

    const result = await runWalletDormancySweep(NOW);

    expect(result.reminders).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('isolates a failed reminder publish — one bad row never aborts the batch', async () => {
    mockFindExpiringBetween
      .mockResolvedValueOnce([wallet({ id: 'bad' }), wallet({ id: 'good' })])
      .mockResolvedValueOnce([]);
    mockPublish.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    const result = await runWalletDormancySweep(NOW);

    expect(result.reminders).toBe(1); // only the good row counted
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'credit_dormancy_reminder_sent',
      expect.objectContaining({ wallet_id: 'good' })
    );
    // Structured (Axiom) error carries only walletId + the message (no wallet row / PII).
    expect(mockLogger.error).toHaveBeenCalledWith(
      { walletId: 'bad', band: 60, error: 'boom' },
      'Dormancy reminder failed'
    );
  });
});

describe('runWalletDormancySweep — expiry pass (D4)', () => {
  const expiredResult = {
    outcome: 'expired' as const,
    entry: { idempotencyKey: 'dormancy_expiry:wallet-1:2026-07-16', amountMinor: -34700 },
    expiredMinor: 34700,
    companyId: 'company-1',
    expiresAt: new Date('2026-07-16T00:00:00Z'),
  };

  it('on `expired`: posts the notice AND the money analytic (once)', async () => {
    mockFindExpirable.mockResolvedValue([wallet({ id: 'wallet-1' })]);
    mockExpireDormant.mockResolvedValue(expiredResult);

    const result = await runWalletDormancySweep(NOW);

    expect(result.expired).toBe(1);
    expect(mockExpireDormant).toHaveBeenCalledWith({ walletId: 'wallet-1', now: NOW });
    expect(mockPublish).toHaveBeenCalledWith('credit.balance_expired', {
      correlationId: 'dormancy_expiry:wallet-1:2026-07-16',
      walletId: 'wallet-1',
      companyId: 'company-1',
      expiresAt: '2026-07-16T00:00:00.000Z',
      expiredMinor: 34700,
    });
    expect(mockTrackServer).toHaveBeenCalledWith('credit_balance_expired', {
      expired_minor: 34700,
      company_id: 'company-1',
      wallet_id: 'wallet-1',
      distinct_id: 'company-1',
    });
    // Structured summary logged for Axiom visibility of the daily expiry job.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { reminders: 0, expired: 1 },
      'Wallet dormancy sweep complete'
    );
  });

  it('on `already_expired` (replay): re-publishes the notice but emits NO analytics', async () => {
    mockFindExpirable.mockResolvedValue([wallet({ id: 'wallet-1' })]);
    mockExpireDormant.mockResolvedValue({
      outcome: 'already_expired',
      entry: { idempotencyKey: 'dormancy_expiry:wallet-1:2026-07-16', amountMinor: -500 },
      companyId: 'company-1',
      expiresAt: new Date('2026-07-16T00:00:00Z'),
    });

    const result = await runWalletDormancySweep(NOW);

    expect(result.expired).toBe(0); // replay is not counted as an expiry
    expect(mockPublish).toHaveBeenCalledWith(
      'credit.balance_expired',
      expect.objectContaining({
        correlationId: 'dormancy_expiry:wallet-1:2026-07-16',
        expiredMinor: 500,
      })
    );
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('on `skipped` (top-up race / no balance): no notice, no analytics', async () => {
    mockFindExpirable.mockResolvedValue([wallet({ id: 'wallet-1' })]);
    mockExpireDormant.mockResolvedValue({ outcome: 'skipped', reason: 'not_expired' });

    const result = await runWalletDormancySweep(NOW);

    expect(result.expired).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('isolates a failed expiry — one bad wallet never aborts the batch', async () => {
    mockFindExpirable.mockResolvedValue([wallet({ id: 'bad' }), wallet({ id: 'good' })]);
    mockExpireDormant
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValueOnce({ ...expiredResult, entry: { ...expiredResult.entry } });

    const result = await runWalletDormancySweep(NOW);

    expect(result.expired).toBe(1); // only the good row
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    // Structured (Axiom) error carries only walletId + the message (no wallet row / PII).
    expect(mockLogger.error).toHaveBeenCalledWith(
      { walletId: 'bad', error: 'lock timeout' },
      'Dormancy expiry failed'
    );
  });
});

describe('config knobs', () => {
  it('exposes the daily 03:00 UTC cron and the queue name', () => {
    expect(WALLET_DORMANCY_SWEEP_CRON).toBe('0 3 * * *');
    expect(WALLET_DORMANCY_SWEEP_QUEUE).toBe('wallet-dormancy-sweep');
  });
});
