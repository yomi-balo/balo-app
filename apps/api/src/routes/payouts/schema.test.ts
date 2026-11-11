import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const mockAirwallexRequest = vi.fn();
vi.mock('../../services/airwallex/client.js', () => ({
  airwallexRequest: (...args: unknown[]) => mockAirwallexRequest(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const auth = vi.hoisted(() => ({ mode: 'authenticated' as 'authenticated' | 'unauthenticated' }));
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (
    request: { userId?: string },
    reply: { status: (code: number) => { send: (body: unknown) => void } }
  ) => {
    if (auth.mode === 'authenticated') {
      request.userId = 'user_1';
      return;
    }
    reply.status(401).send({ error: 'Unauthorized' });
  },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { schemaRoute } from './schema.js';
import {
  AirwallexApiError,
  AirwallexAuthError,
  AirwallexConfigError,
} from '../../services/airwallex/errors.js';

describe('GET /api/payouts/schema', () => {
  let app: FastifyInstance;
  const logError = vi.fn();

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.log.error = logError;
    await app.register(schemaRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    auth.mode = 'authenticated';
  });

  const get = (query = 'country=AU&currency=AUD') =>
    app.inject({ method: 'GET', url: `/api/payouts/schema?${query}` });

  it('returns normalized fields and hidden defaults on success', async () => {
    mockAirwallexRequest.mockResolvedValue({
      condition: { bank_country_code: 'AU' },
      fields: [
        {
          path: 'beneficiary.bank_details.account_name',
          required: true,
          enabled: true,
          rule: { type: 'STRING', pattern: '^.+$' },
          field: { key: 'account_name', label: 'Account name', type: 'INPUT' },
        },
        {
          path: 'beneficiary.bank_details.account_routing_type1',
          required: true,
          enabled: false,
          field: { key: 'routing', label: 'Routing', type: 'SELECT', default: 'bsb' },
        },
      ],
    });

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      fields: [
        expect.objectContaining({
          path: 'beneficiary.bank_details.account_name',
          type: 'text',
          wide: true,
          validation: { pattern: '^.+$' },
        }),
      ],
      hiddenDefaults: { 'beneficiary.bank_details.account_routing_type1': 'bsb' },
      condition: { bank_country_code: 'AU' },
    });
    expect(mockAirwallexRequest).toHaveBeenCalledWith(
      'POST',
      '/beneficiary_form_schemas/generate',
      expect.objectContaining({ bank_country_code: 'AU', account_currency: 'AUD' })
    );
  });

  it('returns 401 without a session and never calls Airwallex', async () => {
    auth.mode = 'unauthenticated';

    const res = await get();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockAirwallexRequest).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid query parameters without calling Airwallex', async () => {
    const res = await get('country=AUS');
    expect(res.statusCode).toBe(400);
    expect(mockAirwallexRequest).not.toHaveBeenCalled();
  });

  it('returns 400 when Airwallex rejects the combination', async () => {
    mockAirwallexRequest.mockRejectedValue(new AirwallexApiError(400, '/x', 'unsupported'));
    const res = await get();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not supported/);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('logs the Airwallex status and body on a 502 from an API error', async () => {
    mockAirwallexRequest.mockRejectedValue(
      new AirwallexApiError(401, '/beneficiary_form_schemas/generate', '{"code":"unauthorized"}')
    );

    const res = await get();

    expect(res.statusCode).toBe(502);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        countryCode: 'AU',
        currency: 'AUD',
        airwallexStatus: 401,
        airwallexBody: '{"code":"unauthorized"}',
      }),
      'Airwallex schema fetch failed'
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [captured, context] = mockCaptureException.mock.calls[0] ?? [];
    expect(captured).toBeInstanceOf(AirwallexApiError);
    expect(context.extra).toEqual({
      countryCode: 'AU',
      method: 'LOCAL',
      currency: 'AUD',
      airwallexStatus: 401,
      op: 'payout_form_schema',
    });
    expect(context.extra).not.toHaveProperty('airwallexBody');
  });

  it('logs the login status on a 502 from an auth error', async () => {
    mockAirwallexRequest.mockRejectedValue(new AirwallexAuthError('bad key', 401));

    const res = await get();

    expect(res.statusCode).toBe(502);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ airwallexStatus: 401, airwallexBody: 'bad key' }),
      'Airwallex schema fetch failed'
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(AirwallexAuthError),
      expect.objectContaining({
        extra: expect.objectContaining({ airwallexStatus: 401, op: 'payout_form_schema' }),
      })
    );
  });

  it('logs the missing variables on a 502 from a config error', async () => {
    mockAirwallexRequest.mockRejectedValue(new AirwallexConfigError(['AIRWALLEX_API_KEY_DEMO']));

    const res = await get();

    expect(res.statusCode).toBe(502);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        airwallexStatus: undefined,
        error: 'Airwallex is not configured: missing AIRWALLEX_API_KEY_DEMO',
      }),
      'Airwallex schema fetch failed'
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(AirwallexConfigError),
      expect.objectContaining({
        extra: expect.objectContaining({ countryCode: 'AU', op: 'payout_form_schema' }),
      })
    );
  });

  it('caps the logged Airwallex body at 2048 characters', async () => {
    mockAirwallexRequest.mockRejectedValue(new AirwallexApiError(500, '/x', 'a'.repeat(3000)));

    await get();

    const [logged] = logError.mock.calls[0] ?? [];
    expect(logged.airwallexBody).toHaveLength(2048);
    const [captured] = mockCaptureException.mock.calls[0] ?? [];
    expect(captured.message.length).toBeLessThanOrEqual(2048 + 100);
  });
});
