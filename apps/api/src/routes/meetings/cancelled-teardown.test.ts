import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockTearDownCancelledMeetings = vi.fn();
vi.mock('../../services/meetings/meeting-availability.js', () => ({
  tearDownCancelledMeetings: (...args: unknown[]) => mockTearDownCancelledMeetings(...args),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { meetingCancelledTeardownRoutes } from './cancelled-teardown.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const MEETING_ID = '550e8400-e29b-41d4-a716-446655440000';
const EXPERT_PROFILE_ID = '550e8400-e29b-41d4-a716-446655440099';

describe('POST /meetings/cancelled-teardown', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = Fastify({ logger: false });
    await app.register(meetingCancelledTeardownRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTearDownCancelledMeetings.mockResolvedValue({ processed: 1, skipped: 0 });
  });

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/meetings/cancelled-teardown',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body && { payload: body }),
    });
  }

  it('returns 401 when the x-internal-api-key header is missing', async () => {
    const res = await inject({ meetings: [{ meetingId: MEETING_ID, expertProfileId: null }] });
    expect(res.statusCode).toBe(401);
    expect(mockTearDownCancelledMeetings).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal key is wrong', async () => {
    const res = await inject(
      { meetings: [{ meetingId: MEETING_ID, expertProfileId: null }] },
      { 'x-internal-api-key': 'nope' }
    );
    expect(res.statusCode).toBe(401);
    expect(mockTearDownCancelledMeetings).not.toHaveBeenCalled();
  });

  it('returns 400 on an empty meetings array', async () => {
    const res = await inject({ meetings: [] }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
    expect(mockTearDownCancelledMeetings).not.toHaveBeenCalled();
  });

  it('returns 400 when meetingId is not a uuid', async () => {
    const res = await inject(
      { meetings: [{ meetingId: 'not-a-uuid', expertProfileId: null }] },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(mockTearDownCancelledMeetings).not.toHaveBeenCalled();
  });

  it('rejects an unknown field (.strict())', async () => {
    const res = await inject(
      { meetings: [{ meetingId: MEETING_ID, expertProfileId: null }], extra: 'nope' },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(mockTearDownCancelledMeetings).not.toHaveBeenCalled();
  });

  it('rejects more than 25 entries', async () => {
    const meetings = Array.from({ length: 26 }, () => ({
      meetingId: MEETING_ID,
      expertProfileId: null,
    }));
    const res = await inject({ meetings }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
    expect(mockTearDownCancelledMeetings).not.toHaveBeenCalled();
  });

  it('accepts a null expertProfileId (an admin meeting)', async () => {
    const res = await inject(
      { meetings: [{ meetingId: MEETING_ID, expertProfileId: null }] },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(200);
    expect(mockTearDownCancelledMeetings).toHaveBeenCalledWith(
      [{ meetingId: MEETING_ID, expertProfileId: null }],
      expect.anything()
    );
  });

  it('returns the processed/skipped counts', async () => {
    mockTearDownCancelledMeetings.mockResolvedValue({ processed: 2, skipped: 1 });

    const res = await inject(
      { meetings: [{ meetingId: MEETING_ID, expertProfileId: EXPERT_PROFILE_ID }] },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 2, skipped: 1 });
  });
});
