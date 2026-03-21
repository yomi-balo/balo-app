import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('ioredis', () => ({
  Redis: class {
    quit = vi.fn().mockResolvedValue('OK');
  },
}));

import { createRedisConnection } from './redis.js';

describe('createRedisConnection', () => {
  const originalEnv = process.env.REDIS_URL;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.REDIS_URL = originalEnv;
    } else {
      delete process.env.REDIS_URL;
    }
  });

  it('throws when REDIS_URL is not set', () => {
    delete process.env.REDIS_URL;
    expect(() => createRedisConnection()).toThrow('REDIS_URL is not configured');
  });

  it('creates a new Redis connection when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const conn = createRedisConnection();
    expect(conn).toBeDefined();
  });
});
