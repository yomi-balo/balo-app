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

import { postRescheduleMeeting } from './reschedule-api-client';

const MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCESS_TOKEN = 'workos.access.token';

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

const INPUT = {
  scheduledStart: '2026-09-01T10:00:00.000Z',
  scheduledEnd: '2026-09-01T10:30:00.000Z',
};

function committed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meetingId: MEETING_ID,
    scheduledStart: '2026-09-01T10:00:00.000Z',
    scheduledEnd: '2026-09-01T10:30:00.000Z',
    previousScheduledStart: '2026-09-01T09:00:00.000Z',
    previousScheduledEnd: '2026-09-01T09:30:00.000Z',
    changed: true,
    ...overrides,
  };
}

describe('postRescheduleMeeting', () => {
  it('forwards the viewer`s WorkOS access token, resolved SERVER-SIDE, to the right URL', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, committed()));
    await postRescheduleMeeting(MEETING_ID, INPUT);
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      `http://api.test/meetings/${MEETING_ID}/reschedule`,
      expect.objectContaining({ service: 'balo-api', method: 'POST' })
    );
    expect(lastInit().headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('fails closed to unauthenticated with no session', async () => {
    mockGetSession.mockResolvedValue({ user: undefined, accessToken: undefined });
    const result = await postRescheduleMeeting(MEETING_ID, INPUT);
    expect(result).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('returns the committed window on success', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, committed()));
    const result = await postRescheduleMeeting(MEETING_ID, INPUT);
    expect(result).toEqual({ ok: true, data: committed() });
  });

  it('maps a non-2xx to { ok: false, status, code }', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'window_not_available' }));
    const result = await postRescheduleMeeting(MEETING_ID, INPUT);
    expect(result).toEqual({ ok: false, status: 409, code: 'window_not_available' });
  });

  it('carries retryAfterSeconds only on a 429', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '30' })
    );
    const result = await postRescheduleMeeting(MEETING_ID, INPUT);
    expect(result).toEqual({ ok: false, status: 429, code: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('a transport error becomes status: 0, code: request_failed — nothing throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('network down'));
    await expect(postRescheduleMeeting(MEETING_ID, INPUT)).resolves.toEqual({
      ok: false,
      status: 0,
      code: 'request_failed',
    });
  });

  it('a malformed 200 body degrades to a transport-shaped failure, not a throw', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, { meetingId: MEETING_ID }));
    const result = await postRescheduleMeeting(MEETING_ID, INPUT);
    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
  });
});
