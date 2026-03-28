import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks — vi.hoisted runs before vi.mock factory callbacks ──────

const { mockRedis, mockSendTransacSms, mockIsValid, mockParse } = vi.hoisted(() => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    del: vi.fn(),
    pipeline: vi.fn(() => ({
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  };

  const mockSendTransacSms = vi.fn().mockResolvedValue({ messageId: 12345 });
  const mockIsValid = vi.fn();
  const mockParse = vi.fn();

  return { mockRedis, mockSendTransacSms, mockIsValid, mockParse };
});

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => mockRedis,
}));

vi.mock('../../lib/brevo.js', () => ({
  getBrevoClient: vi.fn().mockResolvedValue({
    transactionalSms: {
      sendTransacSms: mockSendTransacSms,
    },
  }),
  maskPhone: vi.fn((phone: string) => '****' + phone.slice(-4)),
}));

vi.mock('libphonenumber-js/min', () => ({
  isValidPhoneNumber: mockIsValid,
  parsePhoneNumber: mockParse,
}));

vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = 'test-user-id';
  },
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => () => ({
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  })),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /phone/send-otp', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: valid phone number, mobile type
    mockIsValid.mockReturnValue(true);
    mockParse.mockReturnValue({ getType: () => 'MOBILE' });
    mockRedis.get.mockResolvedValue(null);
    mockRedis.ttl.mockResolvedValue(300);
  });

  function inject(body?: unknown) {
    return app.inject({
      method: 'POST',
      url: '/phone/send-otp',
      payload: body,
    });
  }

  it('returns 400 for missing body', async () => {
    const res = await inject(undefined);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_phone');
  });

  it('returns 400 for empty object body', async () => {
    const res = await inject({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_phone');
  });

  it('returns 400 for invalid phone (non-E.164 format)', async () => {
    const res = await inject({ phone: '412345678' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_phone');
  });

  it('returns 400 when libphonenumber rejects the number', async () => {
    mockIsValid.mockReturnValue(false);

    const res = await inject({ phone: '+61412345678' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_phone');
  });

  it('returns 400 for landline number', async () => {
    mockParse.mockReturnValue({ getType: () => 'FIXED_LINE' });

    const res = await inject({ phone: '+61212345678' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('landline_not_supported');
  });

  it('returns 429 when per-user rate limit exceeded', async () => {
    // First call (user count key) returns "5" — at the MAX_SENDS_PER_USER limit
    mockRedis.get.mockResolvedValueOnce('5');

    const res = await inject({ phone: '+61412345678' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
    expect(res.json().cooldownSeconds).toBeGreaterThan(0);
  });

  it('returns 429 when per-phone rate limit exceeded', async () => {
    // First call (user count key) returns "1" — under user limit
    mockRedis.get.mockResolvedValueOnce('1');
    // Second call (phone count key) returns "3" — at the MAX_SENDS limit
    mockRedis.get.mockResolvedValueOnce('3');

    const res = await inject({ phone: '+61412345678' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
  });

  it('returns 200 with { sent: true } on success', async () => {
    const res = await inject({ phone: '+61412345678' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });
    expect(mockSendTransacSms).toHaveBeenCalledOnce();
  });

  it('stores OTP in Redis with correct key', async () => {
    await inject({ phone: '+61412345678' });

    expect(mockRedis.set).toHaveBeenCalledWith(
      'otp:+61412345678',
      expect.stringContaining('"code"'),
      'EX',
      600
    );
  });

  it('returns 502 when Brevo throws', async () => {
    mockSendTransacSms.mockRejectedValueOnce(new Error('Brevo API down'));

    const res = await inject({ phone: '+61412345678' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('brevo_rejected');
  });
});
