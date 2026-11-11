import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { airwallexRequest, resetTokenCache } from './client.js';
import { AirwallexApiError, AirwallexAuthError, AirwallexConfigError } from './errors.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

const loginOk = (token: string): Response =>
  jsonResponse(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });

describe('airwallexRequest', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetTokenCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('AIRWALLEX_ENV', 'demo');
    vi.stubEnv('AIRWALLEX_API_BASE_DEMO', 'https://aw.test/api/v1');
    vi.stubEnv('AIRWALLEX_CLIENT_ID_DEMO', 'cid');
    vi.stubEnv('AIRWALLEX_API_KEY_DEMO', 'key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('clears the token cache and retries once on a 401 without credentials_expired', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('stale'))
      .mockResolvedValueOnce(jsonResponse(401, { code: 'unauthorized' }))
      .mockResolvedValueOnce(loginOk('fresh'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(airwallexRequest('GET', '/x')).resolves.toEqual({ ok: true });

    const retryHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fresh');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('cancels the unread 401 body before retrying', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    fetchMock
      .mockResolvedValueOnce(loginOk('stale'))
      .mockResolvedValueOnce(new Response(stream, { status: 401 }))
      .mockResolvedValueOnce(loginOk('fresh'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(airwallexRequest('GET', '/x')).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    const retryFetchOrder = fetchMock.mock.invocationCallOrder[3] ?? 0;
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(retryFetchOrder);
  });

  it('retries a 401 that has no body', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('stale'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(loginOk('fresh'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(airwallexRequest('GET', '/x')).resolves.toEqual({ ok: true });
  });

  it('throws the 401 after a single retry instead of looping', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('a'))
      .mockResolvedValueOnce(jsonResponse(401, { code: 'unauthorized' }))
      .mockResolvedValueOnce(loginOk('b'))
      .mockResolvedValueOnce(jsonResponse(401, { code: 'unauthorized' }));

    await expect(airwallexRequest('GET', '/x')).rejects.toMatchObject({
      name: 'AirwallexApiError',
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports the missing variables when Airwallex is not configured', async () => {
    vi.stubEnv('AIRWALLEX_API_BASE_DEMO', '');

    const err = await airwallexRequest('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexConfigError);
    expect((err as AirwallexConfigError).missing).toEqual(['AIRWALLEX_API_BASE_DEMO']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the PROD variables when AIRWALLEX_ENV is prod', async () => {
    vi.stubEnv('AIRWALLEX_ENV', 'prod');
    vi.stubEnv('AIRWALLEX_API_BASE_PROD', 'https://prod.test/api/v1');
    vi.stubEnv('AIRWALLEX_CLIENT_ID_PROD', '');
    vi.stubEnv('AIRWALLEX_API_KEY_PROD', '');

    const err = await airwallexRequest('GET', '/x').catch((e: unknown) => e);
    expect((err as AirwallexConfigError).missing).toEqual([
      'AIRWALLEX_CLIENT_ID_PROD',
      'AIRWALLEX_API_KEY_PROD',
    ]);
  });

  it('throws AirwallexAuthError with the login status when login fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('invalid key', { status: 401 }));

    const err = await airwallexRequest('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexAuthError);
    expect(err).toMatchObject({ status: 401, detail: 'invalid key' });
  });

  it('sends the idempotency key and JSON body', async () => {
    fetchMock.mockResolvedValueOnce(loginOk('t')).mockResolvedValueOnce(jsonResponse(200, {}));

    await airwallexRequest('POST', '/y', { a: 1 }, { idempotencyKey: 'k1' });

    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-idempotency-key']).toBe('k1');
    expect(init.body).toBe('{"a":1}');
  });

  it('surfaces non-401 failures as AirwallexApiError with status and body', async () => {
    fetchMock.mockResolvedValueOnce(loginOk('t')).mockResolvedValueOnce(jsonResponse(500, 'boom'));

    const err = await airwallexRequest('GET', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexApiError);
    expect((err as AirwallexApiError).status).toBe(500);
  });
});
