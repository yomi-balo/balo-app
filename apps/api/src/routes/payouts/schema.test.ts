import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const mockAirwallexRequest = vi.fn();
vi.mock('../../services/airwallex/client.js', () => ({
  airwallexRequest: (...args: unknown[]) => mockAirwallexRequest(...args),
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
  });

  it('logs the login status on a 502 from an auth error', async () => {
    mockAirwallexRequest.mockRejectedValue(new AirwallexAuthError('bad key', 401));

    const res = await get();

    expect(res.statusCode).toBe(502);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ airwallexStatus: 401, airwallexBody: 'bad key' }),
      'Airwallex schema fetch failed'
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
  });
});
