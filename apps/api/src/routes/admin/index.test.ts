import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { mockUsersFindById, mockPerformRedrive, mockWarn, mockError } = vi.hoisted(() => ({
  mockUsersFindById: vi.fn(),
  mockPerformRedrive: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: mockError }),
}));
vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockUsersFindById },
}));
// The real pure platform-authz map — ONLY `super_admin` holds REDRIVE_JOB (D7).
vi.mock('@balo/shared/authz', () => ({
  PLATFORM_CAPABILITIES: { REDRIVE_JOB: 'redrive_job' },
  platformRoleHasCapability: (role: string, capability: string) =>
    role === 'super_admin' && capability === 'redrive_job',
}));
vi.mock('@balo/shared/capture-health', () => ({
  REDRIVE_KINDS: ['recording-ingest', 'transcript-pipeline'],
}));
// ⚠ `requireAuth` sets `request.userId` UNCONDITIONALLY — the point of case (a) below is that
// the capability decision comes from the LIVE `usersRepository.findById` row, never from
// anything the auth layer or a cookie carries alongside the id.
vi.mock('../../lib/require-auth.js', () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = 'user_1';
  },
}));
vi.mock('../../services/admin/redrive.js', () => ({
  performRedrive: mockPerformRedrive,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { adminRoutes } from './index.js';

const RECORDING_ID = '11111111-1111-4111-8111-111111111111';

describe('POST /admin/redrive/:kind/:id', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(adminRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) capability refusal with a STALE COOKIE ROLE but a LIVE DEMOTED user — 403, log.warn, no service call', async () => {
    // `requireAuth`'s mock carries no role at all — the route reads the role off the LIVE
    // `usersRepository.findById` row, and THIS row says `admin` (demoted from `super_admin`).
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/recording-ingest/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect(mockPerformRedrive).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      { kind: 'recording-ingest', entityId: RECORDING_ID, userId: 'user_1' },
      'Admin re-drive denied — lacks platform capability'
    );
  });

  it('(b) super_admin is allowed — 200 with the outcome', async () => {
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'super_admin' });
    mockPerformRedrive.mockResolvedValue({
      ok: true,
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      auditEventId: 'audit-1',
      jobId: 'recording-ingest--rec-1--redrive-audit-1',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/recording-ingest/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      auditEventId: 'audit-1',
      jobId: 'recording-ingest--rec-1--redrive-audit-1',
    });
    expect(mockPerformRedrive).toHaveBeenCalledWith({
      kind: 'recording-ingest',
      entityId: RECORDING_ID,
      actorUserId: 'user_1',
    });
  });

  it('a plain `user` platform role is also refused', async () => {
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'user' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/recording-ingest/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(403);
    expect(mockPerformRedrive).not.toHaveBeenCalled();
  });

  it('a missing user row (live lookup miss) is refused, never treated as an actor', async () => {
    mockUsersFindById.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/recording-ingest/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(403);
    expect(mockPerformRedrive).not.toHaveBeenCalled();
  });

  it('400s on an unknown kind', async () => {
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'super_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/not-a-kind/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(400);
    expect(mockPerformRedrive).not.toHaveBeenCalled();
  });

  it('400s on a non-uuid id', async () => {
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'super_admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/redrive/recording-ingest/not-a-uuid',
    });

    expect(res.statusCode).toBe(400);
    expect(mockPerformRedrive).not.toHaveBeenCalled();
  });

  it('409s when the service reports not_redrivable', async () => {
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'super_admin' });
    mockPerformRedrive.mockResolvedValue({ ok: false, code: 'not_redrivable' });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/recording-ingest/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_redrivable' });
  });

  it('502s when the service reports enqueue_failed, carrying the auditEventId', async () => {
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'super_admin' });
    mockPerformRedrive.mockResolvedValue({
      ok: false,
      code: 'enqueue_failed',
      auditEventId: 'audit-9',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/recording-ingest/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'enqueue_failed', auditEventId: 'audit-9' });
  });

  it('503s on an unexpected throw, logging the error', async () => {
    mockUsersFindById.mockResolvedValue({ id: 'user_1', platformRole: 'super_admin' });
    mockPerformRedrive.mockRejectedValue(new Error('db down'));

    const res = await app.inject({
      method: 'POST',
      url: `/admin/redrive/recording-ingest/${RECORDING_ID}`,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'redrive_unavailable' });
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'recording-ingest',
        entityId: RECORDING_ID,
        userId: 'user_1',
      }),
      'Failed to perform admin re-drive'
    );
  });
});
