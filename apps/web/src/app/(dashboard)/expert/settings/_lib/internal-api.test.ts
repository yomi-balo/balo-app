import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mockLoggedFetch = vi.fn();
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));

interface FetchInit {
  method?: string;
  body?: string;
  service: string;
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function lastInit(): FetchInit {
  return mockLoggedFetch.mock.calls.at(-1)?.[1] as FetchInit;
}

// `API_KEY` is read at module load, so each test imports a fresh copy under a stubbed env.
async function loadInternalApiFetch(): Promise<typeof import('./internal-api').internalApiFetch> {
  vi.resetModules();
  const mod = await import('./internal-api');
  return mod.internalApiFetch;
}

describe('internalApiFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('INTERNAL_API_SECRET', 'secret-123');
    vi.stubEnv('API_URL', 'http://api.test');
    mockLoggedFetch.mockResolvedValue(jsonResponse({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('⚠ a bodyless DELETE sends no JSON content type but keeps the internal key and caller headers', async () => {
    const internalApiFetch = await loadInternalApiFetch();

    await internalApiFetch('/schedule', {
      method: 'DELETE',
      headers: { 'x-actor-user-id': 'user-1' },
    });

    const init = lastInit();
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    // Fastify runs the JSON parser on a DELETE that declares a content type, and a zero-length
    // body is a 400 before the handler.
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers['x-internal-api-key']).toBe('secret-123');
    expect(init.headers['x-actor-user-id']).toBe('user-1');
  });

  it('a GET sends no JSON content type', async () => {
    const internalApiFetch = await loadInternalApiFetch();

    await internalApiFetch('/schedule');

    expect(lastInit().headers['Content-Type']).toBeUndefined();
  });

  it('a PUT with a body declares the JSON content type over it', async () => {
    const internalApiFetch = await loadInternalApiFetch();

    await internalApiFetch('/schedule', { method: 'PUT', body: '{"a":1}' });

    const init = lastInit();
    expect(init.body).toBe('{"a":1}');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['x-internal-api-key']).toBe('secret-123');
  });

  it('a caller header still overrides the defaults', async () => {
    const internalApiFetch = await loadInternalApiFetch();

    await internalApiFetch('/schedule', {
      method: 'PUT',
      body: 'x',
      headers: { 'Content-Type': 'text/plain' },
    });

    expect(lastInit().headers['Content-Type']).toBe('text/plain');
  });

  it('⚠ a caller header can never override the internal key', async () => {
    const internalApiFetch = await loadInternalApiFetch();

    await internalApiFetch('/schedule', { headers: { 'x-internal-api-key': 'evil' } });

    expect(lastInit().headers['x-internal-api-key']).toBe('secret-123');
  });

  it('forwards the service tag and url', async () => {
    const internalApiFetch = await loadInternalApiFetch();

    await internalApiFetch('/schedule', {}, 'schedule-api');

    expect(mockLoggedFetch.mock.calls.at(-1)?.[0]).toBe('http://api.test/schedule');
    expect(lastInit().service).toBe('schedule-api');
  });

  it('throws the api error message on a non-2xx', async () => {
    mockLoggedFetch.mockResolvedValue(jsonResponse({ error: 'nope' }, 400));
    const internalApiFetch = await loadInternalApiFetch();

    await expect(internalApiFetch('/schedule')).rejects.toThrow('nope');
  });

  it('fails fast without the secret', async () => {
    vi.stubEnv('INTERNAL_API_SECRET', '');
    const internalApiFetch = await loadInternalApiFetch();

    await expect(internalApiFetch('/schedule')).rejects.toThrow('INTERNAL_API_SECRET is not set');
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });
});
