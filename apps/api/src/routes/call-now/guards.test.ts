import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  evalScript: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({ eval: mocks.evalScript }) }));

import { CALL_NOW_CALLEE_RATE_LIMIT, releaseCalleeRateLimitSlot } from './guards.js';

const CALLEE = '55555555-5555-4555-8555-555555555555';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('releaseCalleeRateLimitSlot', () => {
  it('gives the slot back on the same key the start metered', async () => {
    mocks.evalScript.mockResolvedValue(2);

    await releaseCalleeRateLimitSlot(CALLEE, { kind: 'company', id: COMPANY_ID });

    expect(mocks.evalScript).toHaveBeenCalledWith(
      expect.any(String),
      1,
      `${CALL_NOW_CALLEE_RATE_LIMIT.keyPrefix}:${CALLEE}:company:${COMPANY_ID}`
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('never throws: a Redis failure is logged at warn and the slot expires with its window', async () => {
    mocks.evalScript.mockRejectedValue(new Error('redis down'));

    await expect(
      releaseCalleeRateLimitSlot(CALLEE, { kind: 'expert_profile', id: COMPANY_ID })
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'redis down' }),
      expect.any(String)
    );
  });
});
