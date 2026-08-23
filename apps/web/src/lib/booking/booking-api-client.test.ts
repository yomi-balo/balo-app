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

import { postBookMeeting, postInviteGuests } from './booking-api-client';

const CASE_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCESS_TOKEN = 'workos.access.token';
const KEY = 'a'.repeat(64);

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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.API_URL = 'http://api.test';
  mockGetSession.mockResolvedValue({
    user: { id: 'user-1', onboardingCompleted: true },
    accessToken: ACCESS_TOKEN,
  });
});

const SERVER_START = '2026-09-01T04:00:00.000Z';
const SERVER_END = '2026-09-01T04:30:00.000Z';

describe('postBookMeeting', () => {
  const INPUT = {
    contextType: 'case' as const,
    contextId: CASE_ID,
    scheduledStart: '2026-09-01T04:00:00.000Z',
    scheduledEnd: '2026-09-01T04:30:00.000Z',
    bookingIdempotencyKey: KEY,
  };

  /** The api's real 201 shape: the window is on it, and so is the raw Daily url. */
  function created(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      meetingId: MEETING_ID,
      scheduledStart: SERVER_START,
      scheduledEnd: SERVER_END,
      provisioned: true,
      joinUrl: 'https://daily.co/room-should-never-leak',
      dailyRoomName: 'room-should-never-leak',
      ...overrides,
    };
  }

  it('forwards the viewer`s WorkOS access token, resolved SERVER-SIDE', async () => {
    mockLoggedFetch.mockResolvedValue(response(201, created()));
    await postBookMeeting(INPUT);
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      'http://api.test/meetings',
      expect.objectContaining({ service: 'balo-api', method: 'POST' })
    );
    expect(lastInit().headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('⚠ NARROWS the 201 body — joinUrl and dailyRoomName never reach the caller', async () => {
    mockLoggedFetch.mockResolvedValue(response(201, created()));
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({
      ok: true,
      data: {
        meetingId: MEETING_ID,
        scheduledStart: SERVER_START,
        scheduledEnd: SERVER_END,
        provisioned: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('daily.co');
    expect(JSON.stringify(result)).not.toContain('room-should-never-leak');
  });

  // ── S2 regression ────────────────────────────────────────────────────────
  it('⚠ KEEPS the SERVER window, even when it differs from the submitted slot (S2)', async () => {
    // The idempotent-replay shape: the api answers 201 with the meeting that already exists,
    // at ITS window — an hour before the one this request asked for.
    mockLoggedFetch.mockResolvedValue(response(201, created()));
    const result = await postBookMeeting({
      ...INPUT,
      scheduledStart: '2026-09-01T05:00:00.000Z',
      scheduledEnd: '2026-09-01T05:30:00.000Z',
    });
    expect(result).toMatchObject({
      ok: true,
      data: { scheduledStart: SERVER_START, scheduledEnd: SERVER_END },
    });
  });

  it('reports provisioned:false without treating it as a failure', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(201, {
        meetingId: MEETING_ID,
        scheduledStart: SERVER_START,
        scheduledEnd: SERVER_END,
        provisioned: false,
      })
    );
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({
      ok: true,
      data: {
        meetingId: MEETING_ID,
        scheduledStart: SERVER_START,
        scheduledEnd: SERVER_END,
        provisioned: false,
      },
    });
  });

  it('maps a 409 idempotency_key_conflict to its fixed literal', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'idempotency_key_conflict' }));
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({ ok: false, status: 409, code: 'idempotency_key_conflict' });
  });

  it('maps a 409 window_not_available to its fixed literal', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'window_not_available' }));
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({ ok: false, status: 409, code: 'window_not_available' });
  });

  it('reads Retry-After only on a 429', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '30' })
    );
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({ ok: false, status: 429, code: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('⚠ FAILS CLOSED on a session with no access token — never an unauthenticated call', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('⚠ status:0 is the TRANSPORT sentinel — a thrown fetch never throws out of this function', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('ECONNRESET'));
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
  });

  it.each([
    { label: 'no meetingId', patch: { meetingId: undefined } },
    // ⚠ S2 — the window is REQUIRED. Falling back to the submitted slot would silently
    // reinstate "client input re-presented as a server fact".
    { label: 'no scheduledStart', patch: { scheduledStart: undefined } },
    { label: 'no scheduledEnd', patch: { scheduledEnd: undefined } },
    { label: 'an unparseable scheduledStart', patch: { scheduledStart: 'not-an-instant' } },
    { label: 'a non-boolean provisioned', patch: { provisioned: 'yes' } },
  ])('treats a malformed 2xx body ($label) as a transport-shaped failure', async ({ patch }) => {
    mockLoggedFetch.mockResolvedValue(response(201, created(patch)));
    const result = await postBookMeeting(INPUT);
    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
  });
});

describe('postInviteGuests', () => {
  it('sends entryPoint: booking_confirm and the guest list', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(201, { guests: [{ id: 'g1' }], participantCount: 2, participantCap: 10 })
    );
    await postInviteGuests(MEETING_ID, [{ email: 'a@b.com', name: 'A' }]);
    const body = JSON.parse(lastInit().body ?? '{}');
    expect(body).toEqual({
      entryPoint: 'booking_confirm',
      guests: [{ email: 'a@b.com', name: 'A' }],
    });
  });

  it('counts the invited guests from the response', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(201, {
        guests: [{ id: 'g1' }, { id: 'g2' }],
        participantCount: 3,
        participantCap: 10,
      })
    );
    const result = await postInviteGuests(MEETING_ID, [{ email: 'a@b.com' }, { email: 'c@d.com' }]);
    expect(result).toEqual({ ok: true, data: { invitedCount: 2 } });
  });

  it('maps a non-2xx to its fixed literal without throwing', async () => {
    mockLoggedFetch.mockResolvedValue(response(422, { error: 'freemail_guest_rejected' }));
    const result = await postInviteGuests(MEETING_ID, [{ email: 'a@b.com' }]);
    expect(result).toEqual({ ok: false, status: 422, code: 'freemail_guest_rejected' });
  });
});
