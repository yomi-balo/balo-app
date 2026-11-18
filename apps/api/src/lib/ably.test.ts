import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRestCtor } = vi.hoisted(() => ({ mockRestCtor: vi.fn() }));

vi.mock('ably', () => ({
  Rest: class {
    constructor(options: unknown) {
      mockRestCtor(options);
    }
  },
}));

// ⚠ `vi.resetModules()` + a dynamic import PER TEST — the REST client is a module-level
// singleton, so a shared import would leak one test's client into the next.
async function load(): Promise<typeof import('./ably.js')> {
  vi.resetModules();
  return import('./ably.js');
}

describe('ably REST seam', () => {
  beforeEach(() => {
    mockRestCtor.mockClear();
    vi.stubEnv('ABLY_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is unconfigured and constructs no client when ABLY_API_KEY is unset', async () => {
    const { isAblyConfigured, getAblyRest } = await load();

    expect(isAblyConfigured()).toBe(false);
    expect(getAblyRest()).toBeNull();
    expect(mockRestCtor).not.toHaveBeenCalled();
  });

  it('is configured when a key is present', async () => {
    vi.stubEnv('ABLY_API_KEY', 'app.key:secret');
    const { isAblyConfigured } = await load();

    expect(isAblyConfigured()).toBe(true);
  });

  it('builds the client with the key and a single bounded attempt', async () => {
    vi.stubEnv('ABLY_API_KEY', 'app.key:secret');
    const { getAblyRest, NOTIFICATION_PUSH_TIMEOUT_MS } = await load();

    expect(getAblyRest()).not.toBeNull();
    expect(NOTIFICATION_PUSH_TIMEOUT_MS).toBe(2_000);
    expect(mockRestCtor).toHaveBeenCalledWith({
      key: 'app.key:secret',
      httpRequestTimeout: 2_000,
      httpMaxRetryCount: 0,
    });
  });

  it('returns one singleton across calls', async () => {
    vi.stubEnv('ABLY_API_KEY', 'app.key:secret');
    const { getAblyRest } = await load();

    expect(getAblyRest()).toBe(getAblyRest());
    expect(mockRestCtor).toHaveBeenCalledTimes(1);
  });
});
