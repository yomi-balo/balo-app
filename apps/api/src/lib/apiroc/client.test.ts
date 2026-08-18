import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApirocClient, getApirocInitReport, __resetApirocClientForTests } from './client.js';
import { ApirocConfigError } from './errors.js';

describe('apiroc client', () => {
  const originalKey = process.env.APIROC_API_KEY;

  beforeEach(() => {
    __resetApirocClientForTests();
    delete process.env.APIROC_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.APIROC_API_KEY;
    } else {
      process.env.APIROC_API_KEY = originalKey;
    }
    __resetApirocClientForTests();
  });

  it('does not construct a client (or throw) merely by importing the module', async () => {
    vi.resetModules();
    await expect(import('./client.js')).resolves.toBeDefined();
    const fresh = await import('./client.js');
    expect(fresh.getApirocInitReport()).toBeNull();
  });

  it('throws ApirocConfigError, not a bare non-null assertion crash, when APIROC_API_KEY is unset', () => {
    expect(() => getApirocClient()).toThrow(ApirocConfigError);
    expect(() => getApirocClient()).toThrow('APIROC_API_KEY is not set');
  });

  it('getApirocInitReport() is null before the first getApirocClient() call', () => {
    expect(getApirocInitReport()).toBeNull();
  });

  it('constructs lazily and returns the same singleton on repeated calls once configured', () => {
    process.env.APIROC_API_KEY = 'test-key';
    const first = getApirocClient();
    const second = getApirocClient();
    expect(first).toBe(second);
  });

  it('reports a full boundary initialisation after first construction', () => {
    process.env.APIROC_API_KEY = 'test-key';
    getApirocClient();
    const report = getApirocInitReport();

    expect(report).not.toBeNull();
    expect(report?.interceptorInstalled).toBe(true);
    expect(report?.interceptorPosition).toBe('first');
    expect(report?.sdkShape.reachedBaseClient).toBe(true);
    expect(report?.sdkShape.reachedClient).toBe(true);
    expect(['prototype', 'failed']).toContain(report?.consoleSuppression);
  });
});
