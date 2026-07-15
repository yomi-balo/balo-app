import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const { mockUpsert, mockGetLatest, mockTrackServer } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockGetLatest: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  fxDisplayRatesRepository: {
    upsert: mockUpsert,
    getLatest: mockGetLatest,
  },
  // Schema-derived quote set (single source of truth).
  fxDisplayQuoteEnum: { enumValues: ['GBP', 'EUR', 'USD'] },
}));

// `@balo/shared/pricing` is pure — use the real isFxRateStale.

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CREDIT_SERVER_EVENTS: {
    DORMANCY_REMINDER_SENT: 'credit_dormancy_reminder_sent',
    BALANCE_EXPIRED: 'credit_balance_expired',
    FX_CACHE_STALE: 'credit_fx_cache_stale',
  },
}));

vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock('bullmq', () => ({ Worker: class MockWorker {} }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  runFxDisplayRateSweep,
  FX_DISPLAY_RATE_SWEEP_CRON,
  FX_DISPLAY_RATE_SWEEP_QUEUE,
} from './fx-display-rate-sweep.js';

const NOW = new Date('2026-07-16T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

/** A well-formed ExchangeRate-API success body. */
function successBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: 'success',
    time_last_update_unix: 1700000000,
    base_code: 'AUD',
    conversion_rates: { AUD: 1, GBP: 0.52, EUR: 0.61, USD: 0.66 },
    ...over,
  };
}

function jsonResponse(body: unknown, over: { ok?: boolean; status?: number } = {}) {
  return { ok: over.ok ?? true, status: over.status ?? 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EXCHANGERATE_API_KEY = 'test-key';
  delete process.env.EXCHANGERATE_API_URL;
  mockGetLatest.mockResolvedValue(undefined); // nothing served → no staleness by default
  mockUpsert.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.EXCHANGERATE_API_KEY;
  delete process.env.EXCHANGERATE_API_URL;
});

describe('runFxDisplayRateSweep — success path', () => {
  it('parses the success body and upserts each schema quote with the source asOf', async () => {
    mockFetch.mockResolvedValue(jsonResponse(successBody()));

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.upserted).toBe(3);
    const asOf = new Date(1700000000 * 1000);
    expect(mockUpsert).toHaveBeenCalledWith({ quote: 'GBP', rate: '0.52', asOf });
    expect(mockUpsert).toHaveBeenCalledWith({ quote: 'EUR', rate: '0.61', asOf });
    expect(mockUpsert).toHaveBeenCalledWith({ quote: 'USD', rate: '0.66', asOf });
  });

  it('calls the default ExchangeRate-API v6 latest-AUD endpoint with the key', async () => {
    mockFetch.mockResolvedValue(jsonResponse(successBody()));

    await runFxDisplayRateSweep(NOW);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://v6.exchangerate-api.com/v6/test-key/latest/AUD',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('honours the EXCHANGERATE_API_URL host override', async () => {
    process.env.EXCHANGERATE_API_URL = 'https://fx.staging.local/v6';
    mockFetch.mockResolvedValue(jsonResponse(successBody()));

    await runFxDisplayRateSweep(NOW);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://fx.staging.local/v6/test-key/latest/AUD',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('skips a missing / non-numeric quote (never writes NaN) but upserts the rest', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(successBody({ conversion_rates: { AUD: 1, GBP: 0.52, USD: 'oops' } }))
    );

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.upserted).toBe(1); // GBP only (EUR absent, USD non-numeric)
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith({
      quote: 'GBP',
      rate: '0.52',
      asOf: new Date(1700000000 * 1000),
    });
  });
});

describe('runFxDisplayRateSweep — last-good fallback', () => {
  it('does NOT upsert when the API key is absent (warn + return, never throw)', async () => {
    delete process.env.EXCHANGERATE_API_KEY;

    const result = await runFxDisplayRateSweep(NOW);

    expect(result).toEqual({ upserted: 0, stale: [] });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('does NOT upsert when result !== "success" (last-good retained)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ result: 'error', 'error-type': 'invalid-key' }));

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.upserted).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('does NOT upsert when the HTTP response is not ok', async () => {
    mockFetch.mockResolvedValue(jsonResponse(successBody(), { ok: false, status: 429 }));

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.upserted).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('does NOT upsert when conversion_rates is missing/malformed', async () => {
    mockFetch.mockResolvedValue(jsonResponse(successBody({ conversion_rates: undefined })));

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.upserted).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('does NOT upsert when fetch throws (network error) — prior rows retained', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.upserted).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('does NOT upsert when the fetch aborts (10s timeout) — never stalls, last-good retained', async () => {
    // AbortSignal.timeout rejects the fetch with a TimeoutError DOMException; it takes the
    // same no-upsert path as any other throw, so a hung upstream never crashes the cron.
    mockFetch.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.upserted).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
    // The abort signal was passed to fetch (the timeout guard is wired).
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe('runFxDisplayRateSweep — staleness emit', () => {
  it('emits credit_fx_cache_stale for a served quote older than 48h', async () => {
    // Fetch fails → last-good retained; staleness reads getLatest.
    mockFetch.mockRejectedValue(new Error('down'));
    const staleAsOf = new Date(NOW.getTime() - 49 * HOUR_MS);
    mockGetLatest.mockImplementation(async (quote: string) =>
      quote === 'GBP' ? { quote, asOf: staleAsOf } : undefined
    );

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.stale).toEqual(['GBP']);
    expect(mockTrackServer).toHaveBeenCalledWith('credit_fx_cache_stale', {
      quote: 'GBP',
      as_of_age_hours: 49,
      distinct_id: 'system:fx-display',
    });
  });

  it('does NOT emit for a fresh served quote (<48h)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(successBody()));
    mockGetLatest.mockResolvedValue({ quote: 'GBP', asOf: new Date(NOW.getTime() - HOUR_MS) });

    const result = await runFxDisplayRateSweep(NOW);

    expect(result.stale).toEqual([]);
    expect(mockTrackServer).not.toHaveBeenCalled();
  });
});

describe('config knobs', () => {
  it('exposes the daily 05:00 UTC cron and the queue name', () => {
    expect(FX_DISPLAY_RATE_SWEEP_CRON).toBe('0 5 * * *');
    expect(FX_DISPLAY_RATE_SWEEP_QUEUE).toBe('fx-display-rate-sweep');
  });
});
