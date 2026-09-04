import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockActorHoldsManageBilling = vi.fn();
const mockSetCompanyBillingEmail = vi.fn();
vi.mock('../../services/billing/authorize-billing-actor.js', () => ({
  actorHoldsManageBilling: (...args: unknown[]) => mockActorHoldsManageBilling(...args),
}));
vi.mock('../../services/billing/set-billing-email.js', () => ({
  setCompanyBillingEmail: (...args: unknown[]) => mockSetCompanyBillingEmail(...args),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { billingEmailRoute } from './billing-email.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const COMPANY_ID = '550e8400-e29b-41d4-a716-446655440000';
const ACTOR_USER_ID = '660e8400-e29b-41d4-a716-446655440001';

describe('POST /credit/billing-email', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = Fastify({ logger: false });
    await app.register(billingEmailRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockActorHoldsManageBilling.mockResolvedValue(true);
  });

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/credit/billing-email',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body && { payload: body }),
    });
  }

  const validBody = {
    companyId: COMPANY_ID,
    actorUserId: ACTOR_USER_ID,
    billingEmail: 'dana@northwind.test',
  };

  it('returns 401 when the x-internal-api-key header is missing', async () => {
    const res = await inject(validBody);
    expect(res.statusCode).toBe(401);
    expect(mockSetCompanyBillingEmail).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal key is wrong', async () => {
    const res = await inject(validBody, { 'x-internal-api-key': 'nope' });
    expect(res.statusCode).toBe(401);
    expect(mockSetCompanyBillingEmail).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_payload for a missing/malformed billingEmail', async () => {
    const res = await inject(
      { companyId: COMPANY_ID, actorUserId: ACTOR_USER_ID, billingEmail: 'not-an-email' },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockSetCompanyBillingEmail).not.toHaveBeenCalled();
  });

  // ⚠ decision 3 — blank rejected.
  it('returns 400 invalid_payload for a whitespace-only billingEmail', async () => {
    const res = await inject(
      { companyId: COMPANY_ID, actorUserId: ACTOR_USER_ID, billingEmail: '   ' },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockSetCompanyBillingEmail).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_payload when companyId is not a uuid', async () => {
    const res = await inject(
      { companyId: 'not-a-uuid', actorUserId: ACTOR_USER_ID, billingEmail: 'dana@northwind.test' },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(mockSetCompanyBillingEmail).not.toHaveBeenCalled();
  });

  it('returns 403 forbidden and never calls the service when the actor lacks MANAGE_BILLING', async () => {
    mockActorHoldsManageBilling.mockResolvedValue(false);
    const res = await inject(validBody, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect(mockSetCompanyBillingEmail).not.toHaveBeenCalled();
  });

  it('returns 200 { status: "updated", billingEmail, setAt } on the happy path', async () => {
    const setAt = new Date('2026-08-01T00:00:00.000Z');
    mockSetCompanyBillingEmail.mockResolvedValue({
      status: 'updated',
      billingEmail: 'dana@northwind.test',
      setAt,
    });
    const res = await inject(validBody, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'updated',
      billingEmail: 'dana@northwind.test',
      setAt: setAt.toISOString(),
    });
    expect(mockActorHoldsManageBilling).toHaveBeenCalledWith(COMPANY_ID, ACTOR_USER_ID);
    expect(mockSetCompanyBillingEmail).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_USER_ID,
      billingEmail: 'dana@northwind.test',
    });
  });

  it('returns 200 { status: "unchanged", ... } when the value did not change', async () => {
    mockSetCompanyBillingEmail.mockResolvedValue({
      status: 'unchanged',
      billingEmail: 'dana@northwind.test',
      setAt: null,
    });
    const res = await inject(validBody, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'unchanged',
      billingEmail: 'dana@northwind.test',
      setAt: null,
    });
  });

  it('returns 404 company_not_found when the service reports not_found', async () => {
    mockSetCompanyBillingEmail.mockResolvedValue({ status: 'not_found' });
    const res = await inject(validBody, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'company_not_found' });
  });

  // The TOCTOU-safe transactional gate — the route already re-gated once above.
  it('returns 403 forbidden when the service itself reports forbidden', async () => {
    mockSetCompanyBillingEmail.mockResolvedValue({ status: 'forbidden' });
    const res = await inject(validBody, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });
});
