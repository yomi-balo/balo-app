import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockPublish } = vi.hoisted(() => {
  const mockPublish = vi.fn().mockResolvedValue(undefined);
  return { mockPublish };
});

vi.mock('../../notifications/index.js', () => ({
  notificationEvents: {
    publish: mockPublish,
  },
}));

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: vi.fn() })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@balo/db', () => ({}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Tests ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';

describe('POST /notifications/publish', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      ...(body && { payload: body }),
    });
  }

  it('returns 401 when x-internal-api-key header is missing', async () => {
    const res = await inject({
      event: 'user.welcome',
      payload: {
        correlationId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '550e8400-e29b-41d4-a716-446655440000',
        role: 'client',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Unauthorized');
  });

  it('returns 401 when key is wrong', async () => {
    const res = await inject(
      {
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          role: 'client',
        },
      },
      { 'x-internal-api-key': 'wrong-key' }
    );
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when body fails Zod validation', async () => {
    const res = await inject(
      { event: 'unknown.event', payload: {} },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
  });

  it('returns 400 when user.welcome payload is missing role', async () => {
    const res = await inject(
      {
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 and publishes user.welcome event', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'client',
    };

    const res = await inject(
      { event: 'user.welcome', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('user.welcome', payload);
  });

  it('returns 200 and publishes expert.application_submitted event', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      applicationId: '550e8400-e29b-41d4-a716-446655440000',
    };

    const res = await inject(
      { event: 'expert.application_submitted', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('expert.application_submitted', payload);
  });

  it('returns 200 and publishes expert.approved event', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440000',
    };

    const res = await inject(
      { event: 'expert.approved', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('expert.approved', payload);
  });

  it('returns 200 and publishes conversation.message_posted (expert recipient)', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440005',
      contextType: 'relationship',
      contextId: '550e8400-e29b-41d4-a716-446655440002',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440001',
      title: 'CPQ implementation',
      senderName: 'Dana Whitfield',
      recipientRole: 'expert',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440003',
      preview: 'Quick question about the price migration',
      sentDuringMeeting: false,
    };

    const res = await inject(
      { event: 'conversation.message_posted', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(mockPublish).toHaveBeenCalledWith('conversation.message_posted', payload);
  });

  /** BAL-424: the ENGAGEMENT arm carries no `projectRequestId` at all — a Case has no request. */
  it('returns 200 for an ENGAGEMENT-anchored message with no projectRequestId', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440005',
      contextType: 'engagement',
      contextId: '550e8400-e29b-41d4-a716-446655440006',
      engagementId: '550e8400-e29b-41d4-a716-446655440006',
      title: 'Salesforce CPQ',
      senderName: 'Dana Whitfield',
      recipientRole: 'expert',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440003',
      preview: 'On the migration plan',
      sentDuringMeeting: true,
    };

    const res = await inject(
      { event: 'conversation.message_posted', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(mockPublish).toHaveBeenCalledWith('conversation.message_posted', payload);
  });

  it('returns 200 and publishes conversation.file_shared (client recipient)', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440005',
      contextType: 'relationship',
      contextId: '550e8400-e29b-41d4-a716-446655440002',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440001',
      title: 'CPQ implementation',
      senderName: 'Priya Nair',
      recipientRole: 'client',
      recipientId: '550e8400-e29b-41d4-a716-446655440004',
      fileName: 'price-book-export.xlsx',
    };

    const res = await inject(
      { event: 'conversation.file_shared', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(mockPublish).toHaveBeenCalledWith('conversation.file_shared', payload);
  });

  /**
   * ⚠ SERVER-ONLY. The debounced digest is published EXCLUSIVELY by the BAL-420 dispatch
   * tick; `scheduleNotification` is in-process and ADR-1047 Decision 11 keeps the
   * schedule/cancel seam off HTTP entirely. It therefore has no `publishBodySchema` arm and
   * the route must refuse it.
   */
  it('returns 400 for the SERVER-ONLY conversation.unread_digest_due', async () => {
    const res = await inject(
      {
        event: 'conversation.unread_digest_due',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          conversationId: '550e8400-e29b-41d4-a716-446655440005',
          contextType: 'engagement',
          contextId: '550e8400-e29b-41d4-a716-446655440006',
          recipientUserId: '550e8400-e29b-41d4-a716-446655440004',
          recipientRole: 'client',
          title: 'Salesforce CPQ',
          senderName: 'Priya',
          unreadMessageCount: 2,
          unreadFileCount: 0,
          latestActivityAtIso: '2026-08-11T10:00:00.000Z',
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns 200 and publishes project.proposal_requested (BAL-272 round-trip)', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440002',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440001',
      relationshipId: '550e8400-e29b-41d4-a716-446655440002',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440003',
      title: 'CPQ implementation',
      initiatedBy: 'client' as const,
    };

    const res = await inject(
      { event: 'project.proposal_requested', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('project.proposal_requested', payload);
  });

  it('returns 400 when project.proposal_requested is missing its expertProfileId', async () => {
    const res = await inject(
      {
        event: 'project.proposal_requested',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440002',
          projectRequestId: '550e8400-e29b-41d4-a716-446655440001',
          relationshipId: '550e8400-e29b-41d4-a716-446655440002',
          title: 'CPQ implementation',
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns 200 and publishes project.exploratory_requested (BAL-284 round-trip)', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440050',
      recipientId: '550e8400-e29b-41d4-a716-446655440051',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440050',
      title: 'CPQ implementation',
    };

    const res = await inject(
      { event: 'project.exploratory_requested', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('project.exploratory_requested', payload);
  });

  it('returns 200 and publishes project.expert_invited (BAL-284 round-trip)', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440060',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440061',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440062',
      title: 'CPQ implementation',
    };

    const res = await inject(
      { event: 'project.expert_invited', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('project.expert_invited', payload);
  });

  it('returns 200 and publishes project.eoi_submitted (BAL-284 round-trip)', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440070',
      recipientId: '550e8400-e29b-41d4-a716-446655440071',
      projectRequestId: '550e8400-e29b-41d4-a716-446655440072',
      title: 'CPQ implementation',
      expertName: 'Ada Lovelace',
    };

    const res = await inject(
      { event: 'project.eoi_submitted', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('project.eoi_submitted', payload);
  });

  it('returns 400 (and does not publish) when project.exploratory_requested is missing recipientId', async () => {
    const res = await inject(
      {
        event: 'project.exploratory_requested',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440050',
          projectRequestId: '550e8400-e29b-41d4-a716-446655440050',
          title: 'CPQ implementation',
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns 400 (and does not publish) when project.eoi_submitted is missing expertName', async () => {
    const res = await inject(
      {
        event: 'project.eoi_submitted',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440070',
          recipientId: '550e8400-e29b-41d4-a716-446655440071',
          projectRequestId: '550e8400-e29b-41d4-a716-446655440072',
          title: 'CPQ implementation',
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns 400 when conversation.message_posted is missing its recipientRole', async () => {
    const res = await inject(
      {
        event: 'conversation.message_posted',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          conversationId: '550e8400-e29b-41d4-a716-446655440005',
          contextType: 'relationship',
          contextId: '550e8400-e29b-41d4-a716-446655440002',
          projectRequestId: '550e8400-e29b-41d4-a716-446655440001',
          title: 'CPQ implementation',
          senderName: 'Dana Whitfield',
          preview: 'hello',
          sentDuringMeeting: false,
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
  });

  /** The anchor is the seam, so a payload without it cannot be routed. */
  it('returns 400 when conversation.message_posted is missing its contextType', async () => {
    const res = await inject(
      {
        event: 'conversation.message_posted',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          conversationId: '550e8400-e29b-41d4-a716-446655440005',
          contextId: '550e8400-e29b-41d4-a716-446655440002',
          title: 'CPQ implementation',
          senderName: 'Dana Whitfield',
          recipientRole: 'expert',
          expertProfileId: '550e8400-e29b-41d4-a716-446655440003',
          preview: 'hello',
          sentDuringMeeting: false,
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
  });
});
