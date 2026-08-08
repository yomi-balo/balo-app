import { describe, expect, it, vi } from 'vitest';
import { TEST_DAILY_API_KEY, jsonResponse, useDailyApiKey } from '../../test/mocks/daily.js';

/**
 * ⚠ THE LAZY-READ GUARANTEE IS PROVEN MECHANICALLY AT THE BOTTOM OF THIS FILE, NOT BY THIS
 * TOP-LEVEL IMPORT. A static import here says nothing: whether `DAILY_API_KEY` was set at
 * module-evaluation time depends on the ambient shell (a developer with a real key in their
 * environment proves nothing, and CI proves it only by accident). The `vi.resetModules()` case
 * in the last describe block below constructs the unset condition explicitly.
 */
import {
  DAILY_API_BASE,
  DAILY_REQUEST_TIMEOUT_MS,
  dailyRequest,
  getDailyApiKey,
} from './client.js';
import { DailyApiError, DailyConfigError } from './errors.js';

useDailyApiKey();

describe('getDailyApiKey', () => {
  it('returns the configured key', () => {
    expect(getDailyApiKey()).toBe(TEST_DAILY_API_KEY);
  });

  it('throws DailyConfigError when DAILY_API_KEY is unset — never a silent undefined', () => {
    delete process.env.DAILY_API_KEY;
    expect(() => getDailyApiKey()).toThrow(DailyConfigError);
  });

  it('throws DailyConfigError when DAILY_API_KEY is empty', () => {
    process.env.DAILY_API_KEY = '';
    expect(() => getDailyApiKey()).toThrow(DailyConfigError);
  });
});

describe('dailyRequest', () => {
  it('POSTs to the Daily base URL with a Bearer header and a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { name: 'r', url: 'u' }));
    vi.stubGlobal('fetch', fetchMock);

    await dailyRequest('POST', '/rooms', { name: 'r' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TEST_DAILY_API_KEY}`,
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe(JSON.stringify({ name: 'r' }));
  });

  it('sends NO Content-Type and NO body on a bodyless GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { name: 'r', url: 'u' }));
    vi.stubGlobal('fetch', fetchMock);

    await dailyRequest('GET', '/rooms/balo-abc');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/balo-abc`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TEST_DAILY_API_KEY}` });
    expect(init.body).toBeUndefined();
  });

  it('attaches an abort signal — Node fetch has no default timeout', async () => {
    // Without this, a hung Daily connection holds open a request whose booking has ALREADY
    // committed. Asserting the signal is present is the mechanical form of that rule.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await dailyRequest('GET', '/rooms/balo-abc');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DAILY_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it('returns the parsed JSON body on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { name: 'balo-abc', url: 'https://x/balo-abc' }))
    );
    await expect(dailyRequest('GET', '/rooms/balo-abc')).resolves.toEqual({
      name: 'balo-abc',
      url: 'https://x/balo-abc',
    });
  });

  it('throws DailyApiError carrying the status and the raw body on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    const error = await dailyRequest('POST', '/rooms', {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    // The raw body is carried for the SERVER log only — §6.3 forbids echoing it to a client.
    expect(error).toMatchObject({
      status: 500,
      method: 'POST',
      path: '/rooms',
      body: JSON.stringify({ error: 'boom' }),
    });
  });

  it('throws DailyConfigError BEFORE issuing any request when the key is missing', async () => {
    delete process.env.DAILY_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(dailyRequest('POST', '/rooms', {})).rejects.toBeInstanceOf(DailyConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the lazy-read guarantee, made MECHANICAL', () => {
  /**
   * ⚠ THIS IS THE ONLY PLACE THE GUARANTEE IS ACTUALLY TESTED. Evaluating this module with
   * `DAILY_API_KEY` genuinely unset requires resetting the module registry and re-importing —
   * the static import at the top of this file evaluates once, under whatever the ambient
   * environment happened to be. A module-level `const key = process.env.DAILY_API_KEY!` would
   * make merely IMPORTING this module fail in every route test and in the shared Fastify app
   * builder, which is exactly what `lib/stripe.ts`'s deferred pattern exists to avoid — and
   * which nothing here would have caught.
   */
  it('EVALUATES cleanly with DAILY_API_KEY unset, and only throws when the key is USED', async () => {
    delete process.env.DAILY_API_KEY;
    vi.resetModules();

    // The import itself must not throw. That is the assertion.
    const fresh = await import('./client.js');
    // Re-imported from the SAME fresh registry, so `instanceof` compares like with like.
    const freshErrors = await import('./errors.js');

    expect(fresh.DAILY_API_BASE).toBe('https://api.daily.co/v1');
    expect(fresh.DAILY_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(() => fresh.getDailyApiKey()).toThrow(freshErrors.DailyConfigError);
  });
});
