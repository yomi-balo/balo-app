import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { checkRateLimit, type RateLimitConfig } from './rate-limiter.js';

// ── Mock Redis pipeline ─────────────────────────────────────────────────────

const mockExec = vi.fn();
const mockPipeline = {
  incr: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  ttl: vi.fn().mockReturnThis(),
  exec: mockExec,
};
const mockRedis = {
  multi: vi.fn(() => mockPipeline),
} as unknown as Redis;

const config: RateLimitConfig = {
  keyPrefix: 'sms:rate',
  maxRequests: 5,
  windowSeconds: 3600,
};

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows the first request in a window (count = 1)', async () => {
    mockExec.mockResolvedValue([
      [null, 1], // INCR → 1
      [null, 1], // EXPIRE NX → 1 (set)
      [null, 3600], // TTL → 3600
    ]);

    const result = await checkRateLimit(mockRedis, config, 'user-1');

    expect(result).toEqual({ allowed: true, current: 1, ttlSeconds: 3600 });
  });

  it('allows requests within the limit (count = 3)', async () => {
    mockExec.mockResolvedValue([
      [null, 3],
      [null, 0], // EXPIRE NX → 0 (already set)
      [null, 2400],
    ]);

    const result = await checkRateLimit(mockRedis, config, 'user-1');

    expect(result).toEqual({ allowed: true, current: 3, ttlSeconds: 2400 });
  });

  it('allows exactly at the limit (count = max)', async () => {
    mockExec.mockResolvedValue([
      [null, 5],
      [null, 0],
      [null, 1800],
    ]);

    const result = await checkRateLimit(mockRedis, config, 'user-1');

    expect(result).toEqual({ allowed: true, current: 5, ttlSeconds: 1800 });
  });

  it('denies when limit is exceeded (count = max + 1)', async () => {
    mockExec.mockResolvedValue([
      [null, 6],
      [null, 0],
      [null, 1500],
    ]);

    const result = await checkRateLimit(mockRedis, config, 'user-1');

    expect(result).toEqual({ allowed: false, current: 6, ttlSeconds: 1500 });
  });

  it('denies when far over limit', async () => {
    mockExec.mockResolvedValue([
      [null, 100],
      [null, 0],
      [null, 600],
    ]);

    const result = await checkRateLimit(mockRedis, config, 'user-1');

    expect(result).toEqual({ allowed: false, current: 100, ttlSeconds: 600 });
  });

  it('constructs the correct Redis key from prefix and identifier', async () => {
    mockExec.mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 3600],
    ]);

    await checkRateLimit(mockRedis, config, 'user-abc-123');

    expect(mockPipeline.incr).toHaveBeenCalledWith('sms:rate:user-abc-123');
    expect(mockPipeline.expire).toHaveBeenCalledWith('sms:rate:user-abc-123', 3600, 'NX');
    expect(mockPipeline.ttl).toHaveBeenCalledWith('sms:rate:user-abc-123');
  });

  it('uses EXPIRE NX to only set TTL on first request', async () => {
    mockExec.mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 3600],
    ]);

    await checkRateLimit(mockRedis, config, 'user-1');

    // Verify the NX flag is passed
    expect(mockPipeline.expire).toHaveBeenCalledWith('sms:rate:user-1', 3600, 'NX');
  });

  it('runs all commands in a single MULTI/EXEC pipeline', async () => {
    mockExec.mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 3600],
    ]);

    await checkRateLimit(mockRedis, config, 'user-1');

    expect(mockRedis.multi).toHaveBeenCalledOnce();
    expect(mockPipeline.exec).toHaveBeenCalledOnce();
  });

  it('throws when pipeline returns null (aborted transaction)', async () => {
    mockExec.mockResolvedValue(null);

    await expect(checkRateLimit(mockRedis, config, 'user-1')).rejects.toThrow(
      'Rate limit Redis pipeline returned no results'
    );
  });

  it('throws when a sub-command returns an error', async () => {
    mockExec.mockResolvedValue([
      [new Error('OOM command not allowed'), null],
      [null, 0],
      [null, -1],
    ]);

    await expect(checkRateLimit(mockRedis, config, 'user-1')).rejects.toThrow(
      'Rate limit Redis command failed: OOM command not allowed'
    );
  });

  it('throws when pipeline.exec() rejects (connection error)', async () => {
    mockExec.mockRejectedValue(new Error('Connection refused'));

    await expect(checkRateLimit(mockRedis, config, 'user-1')).rejects.toThrow('Connection refused');
  });
});
