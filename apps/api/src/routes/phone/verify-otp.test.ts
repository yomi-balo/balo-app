import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks — vi.hoisted runs before vi.mock factory callbacks ──────

const { mockRedis, mockSetPhoneVerified } = vi.hoisted(() => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };

  const mockSetPhoneVerified = vi.fn().mockResolvedValue(undefined);

  return { mockRedis, mockSetPhoneVerified };
});

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => mockRedis,
}));

vi.mock('../../lib/brevo.js', () => ({
  getBrevoClient: vi.fn(),
  maskPhone: vi.fn((phone: string) => '****' + phone.slice(-4)),
}));

vi.mock('libphonenumber-js/min', () => ({
  isValidPhoneNumber: vi.fn().mockReturnValue(true),
  parsePhoneNumber: vi.fn().mockReturnValue({ getType: () => 'MOBILE' }),
}));

vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = 'test-user-id';
  },
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => (mod: string) => {
    if (mod === '@balo/db') {
      return {
        usersRepository: {
          setPhoneVerified: mockSetPhoneVerified,
        },
      };
    }
    // Default: logging
    return {
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    };
  }),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /phone/verify-otp', () => {
  let app: FastifyInstance;

  const PHONE = '+61412345678';
  const CODE = '123456';

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function inject(body?: unknown) {
    return app.inject({
      method: 'POST',
      url: '/phone/verify-otp',
      payload: body,
    });
  }

  it('returns 400 for invalid body (missing fields)', async () => {
    const res = await inject({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_input');
  });

  it('returns 400 for invalid body (bad code format)', async () => {
    const res = await inject({ phone: PHONE, code: '12ab' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_input');
  });

  it('returns 400 with code_expired when Redis key missing', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    const res = await inject({ phone: PHONE, code: CODE });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('code_expired');
  });

  it('returns 400 with wrong_code on first wrong attempt (attemptsRemaining: 2)', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ code: '999999', attempts: 0 }));

    const res = await inject({ phone: PHONE, code: CODE });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'wrong_code', attemptsRemaining: 2 });

    // Should update attempts in Redis
    expect(mockRedis.set).toHaveBeenCalledWith(
      `otp:${PHONE}`,
      JSON.stringify({ code: '999999', attempts: 1 }),
      'KEEPTTL'
    );
  });

  it('returns 400 with final_attempt on second wrong attempt (attemptsRemaining: 1)', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ code: '999999', attempts: 1 }));

    const res = await inject({ phone: PHONE, code: CODE });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'final_attempt', attemptsRemaining: 1 });
  });

  it('returns 400 with locked_out on third wrong attempt', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ code: '999999', attempts: 2 }));

    const res = await inject({ phone: PHONE, code: CODE });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'locked_out' });

    // Should delete the OTP key on lockout
    expect(mockRedis.del).toHaveBeenCalledWith(`otp:${PHONE}`);
  });

  it('returns 400 with locked_out when attempts already >= 3', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ code: '999999', attempts: 3 }));

    const res = await inject({ phone: PHONE, code: CODE });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'locked_out' });
  });

  it('returns 200 with { verified: true } on correct code', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ code: CODE, attempts: 0 }));

    const res = await inject({ phone: PHONE, code: CODE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ verified: true });

    // Should clean up Redis keys
    expect(mockRedis.del).toHaveBeenCalledWith(`otp:${PHONE}`, `otp:sends:${PHONE}`);

    // Should call repository to mark phone as verified
    expect(mockSetPhoneVerified).toHaveBeenCalledWith('test-user-id', PHONE, expect.any(Date));
  });

  it('returns 200 on correct code even with previous failed attempts', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({ code: CODE, attempts: 2 }));

    const res = await inject({ phone: PHONE, code: CODE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ verified: true });
  });
});
