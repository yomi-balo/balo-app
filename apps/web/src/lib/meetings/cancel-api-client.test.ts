import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggedFetch = vi.fn();
const mockGetSession = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { postCancelMeeting } from './cancel-api-client';

const MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCESS_TOKEN = 'workos.access.token';
const AUDIT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = '2026-09-01T10:00:00.000Z';

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function lastInit(): { headers: Record<string, string>; body?: string; method: string } {
  return mockLoggedFetch.mock.calls.at(-1)?.[1] as {
    headers: Record<string, string>;
    body?: string;
    method: string;
  };
}

/** A well-formed 200 body, with any field swapped out to exercise one guard at a time. */
function cancelled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meetingId: MEETING_ID,
    status: 'cancelled',
    scheduledStart: START,
    cancelAuditId: AUDIT_ID,
    initiatedBy: 'client',
    holdReleased: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.API_URL = 'http://api.test';
  mockGetSession.mockResolvedValue({
    user: { id: 'user-1', onboardingCompleted: true },
    accessToken: ACCESS_TOKEN,
  });
});

describe('postCancelMeeting', () => {
  it('forwards the viewer`s WorkOS access token, resolved SERVER-SIDE, to the right URL', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, cancelled()));

    await postCancelMeeting(MEETING_ID);

    expect(mockLoggedFetch).toHaveBeenCalledWith(
      `http://api.test/meetings/${MEETING_ID}/cancel`,
      expect.objectContaining({ service: 'balo-api', method: 'POST' })
    );
    expect(lastInit().headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  /**
   * ⚠ THE BODY IS `{}` AND MUST STAY `{}`. The api's schema is `z.object({}).strict()`, so a
   * "helpful" extra field (a `reason`, an `initiatedBy`) is a 400, not a stripped no-op — those
   * are SERVER decisions. This assertion is the guard on that.
   */
  it('posts an EMPTY body — reason and initiatedBy are server decisions', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, cancelled()));

    await postCancelMeeting(MEETING_ID);

    expect(lastInit().body).toBe('{}');
  });

  it('fails closed to unauthenticated with no session', async () => {
    mockGetSession.mockResolvedValue({ user: undefined, accessToken: undefined });

    const result = await postCancelMeeting(MEETING_ID);

    expect(result).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('returns the parsed cancellation on success', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, cancelled({ holdReleased: true })));

    const result = await postCancelMeeting(MEETING_ID);

    expect(result).toEqual({
      ok: true,
      data: {
        meetingId: MEETING_ID,
        status: 'cancelled',
        scheduledStart: START,
        cancelAuditId: AUDIT_ID,
        initiatedBy: 'client',
        holdReleased: true,
      },
    });
  });

  /**
   * ⚠⚠ `holdReleased` IS THE CLIENT ARM'S ALONE (security LOW-1) — the hold is the CLIENT's
   * money, and the api omits the key on the other two arms. `null` here means "NOT DISCLOSED",
   * never "no hold was released".
   */
  it.each(['expert', 'admin'] as const)(
    'succeeds with holdReleased: null on the %s arm, where the api omits the key',
    async (initiatedBy) => {
      // `undefined` ⇒ `JSON.stringify` drops the key entirely, which is what the api sends.
      mockLoggedFetch.mockResolvedValue(
        response(200, cancelled({ initiatedBy, holdReleased: undefined }))
      );

      const result = await postCancelMeeting(MEETING_ID);

      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(result.ok && result.data).toMatchObject({ initiatedBy, holdReleased: null });
    }
  );

  /** ⚠ DISCARDED, not surfaced — a stale api cannot undo the concealment from the wire. */
  it('⚠ DISCARDS a holdReleased that arrives on a non-client arm', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(200, cancelled({ initiatedBy: 'expert', holdReleased: true }))
    );

    const result = await postCancelMeeting(MEETING_ID);

    expect(result.ok && result.data.holdReleased).toBeNull();
  });

  /**
   * The route answers a fixed `status` literal; the parser RESTATES it rather than trusting the
   * wire, so an arbitrary string can never widen the union downstream.
   */
  it('restates status as the `cancelled` literal rather than echoing the wire', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, cancelled({ status: 'something-else' })));

    const result = await postCancelMeeting(MEETING_ID);

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(result.ok && result.data.status).toBe('cancelled');
  });

  it.each(['client', 'expert', 'admin'] as const)(
    'accepts initiatedBy: %s — the axis is AUTHORITATIVE and never re-derived from the lens',
    async (initiatedBy) => {
      mockLoggedFetch.mockResolvedValue(response(200, cancelled({ initiatedBy })));

      const result = await postCancelMeeting(MEETING_ID);

      expect(result.ok && result.data.initiatedBy).toBe(initiatedBy);
    }
  );

  /**
   * ⚠ ALL FIVE GUARDS, ONE PER CASE. A malformed 200 must degrade to a transport-shaped failure
   * (which the Server Action maps to its generic `unknown` refusal), never a throw and never a
   * half-populated object.
   */
  it.each([
    ['meetingId missing', { meetingId: undefined }],
    ['meetingId not a string', { meetingId: 42 }],
    ['scheduledStart missing', { scheduledStart: undefined }],
    ['scheduledStart not a parseable instant', { scheduledStart: 'not-a-date' }],
    ['cancelAuditId missing', { cancelAuditId: undefined }],
    ['cancelAuditId not a string', { cancelAuditId: null }],
    ['initiatedBy missing', { initiatedBy: undefined }],
    ['initiatedBy outside the three literals', { initiatedBy: 'guest' }],
    // ⚠ REQUIRED ON THE CLIENT ARM ONLY — these two fixtures are `initiatedBy: 'client'`.
    ['holdReleased missing on the client arm', { holdReleased: undefined }],
    ['holdReleased not a boolean on the client arm', { holdReleased: 'true' }],
  ])('a 200 with %s degrades to a transport-shaped failure, not a throw', async (_label, patch) => {
    mockLoggedFetch.mockResolvedValue(response(200, cancelled(patch)));

    await expect(postCancelMeeting(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 0,
      code: 'request_failed',
    });
  });

  it('maps a non-2xx to { ok: false, status, code } using the api`s fixed literal', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'meeting_not_cancellable' }));

    const result = await postCancelMeeting(MEETING_ID);

    expect(result).toEqual({ ok: false, status: 409, code: 'meeting_not_cancellable' });
  });

  it('falls back to request_failed when a non-2xx carries no error literal', async () => {
    mockLoggedFetch.mockResolvedValue(response(500, {}));

    const result = await postCancelMeeting(MEETING_ID);

    expect(result).toEqual({ ok: false, status: 500, code: 'request_failed' });
  });

  it('carries retryAfterSeconds only on a 429', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '30' })
    );

    const result = await postCancelMeeting(MEETING_ID);

    expect(result).toEqual({ ok: false, status: 429, code: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('ignores a Retry-After on a status that is not 429', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(503, { error: 'request_failed' }, { 'Retry-After': '30' })
    );

    const result = await postCancelMeeting(MEETING_ID);

    expect(result).toEqual({ ok: false, status: 503, code: 'request_failed' });
  });

  it('a transport error becomes status: 0, code: request_failed — nothing throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('network down'));

    await expect(postCancelMeeting(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 0,
      code: 'request_failed',
    });
  });
});
