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

import { log } from '@/lib/logging';
import { endMeeting, getMeetingState } from './meeting-lifecycle-client';

/**
 * BAL-134 (§7.1 / §5.4) — the server-only web→api hop for the two member lifecycle routes.
 *
 * ⚠⚠ **THE FIRST DESCRIBE BLOCK IS THE WHOLE REASON THIS FILE EXISTS.** `callMeetingApi` set
 * `Content-Type: application/json` unconditionally and NEVER set a `body`, so the `POST` went out
 * with `Content-Length: 0` and Fastify's default JSON parser rejected it with
 * `FST_ERR_CTP_EMPTY_JSON_BODY` (400) **before the route handler ran**. The End button therefore
 * failed on EVERY press in production: the person saw `END_MEETING_FAILED_COPY`, the Daily room
 * was never deleted, and the presence intervals stayed open — the exact defect BAL-134 exists to
 * fix.
 *
 * ⚠ AND NO GATE CAUGHT IT. `apps/api`'s `end.test.ts` drives the route through `app.inject`,
 * which sends no content-type and never reaches the parser. The guard has to live on THIS side,
 * asserting the outgoing `fetch` init.
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const ACCESS_TOKEN = 'workos.access.token';

/** A minimal `Response` stand-in — only what the client touches. */
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function lastInit(): FetchInit {
  return mockLoggedFetch.mock.calls.at(-1)?.[1] as FetchInit;
}

function lastUrl(): string {
  return mockLoggedFetch.mock.calls.at(-1)?.[0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: 'user_1' }, accessToken: ACCESS_TOKEN });
});

describe('⚠⚠ endMeeting sends a BODY on the POST (the production regression guard)', () => {
  it('carries `{}` as the request body', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, { status: 'ended' }));

    await endMeeting(MEETING_ID);

    const init = lastInit();
    expect(init.method).toBe('POST');
    // ⚠ THIS IS THE ASSERTION. `undefined` here is `Content-Length: 0` on the wire, and Fastify
    // answers `400 FST_ERR_CTP_EMPTY_JSON_BODY` before the handler runs.
    expect(init.body).toBe('{}');
  });

  it('⚠ the body is present AND the JSON content type is declared — the pair must agree', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, {}));

    await endMeeting(MEETING_ID);

    expect(lastInit().headers['Content-Type']).toBe('application/json');
    expect(lastInit().body).toBeDefined();
    expect(JSON.parse(lastInit().body ?? 'null')).toEqual({});
  });

  it('⚠ the GET carries NEITHER a body nor a JSON content type', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, {}));

    await getMeetingState(MEETING_ID);

    const init = lastInit();
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    // A JSON content type on a bodyless GET is a claim about a payload that is not there.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('⚠ the Bearer is present on both, and the token never reaches the URL', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, {}));

    await getMeetingState(MEETING_ID);
    expect(lastInit().headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(lastUrl()).not.toContain(ACCESS_TOKEN);

    await endMeeting(MEETING_ID);
    expect(lastInit().headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(lastUrl()).not.toContain(ACCESS_TOKEN);
  });

  it('routes to the right paths', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, {}));

    await getMeetingState(MEETING_ID);
    expect(lastUrl()).toContain(`/meetings/${MEETING_ID}/state`);

    await endMeeting(MEETING_ID);
    expect(lastUrl()).toContain(`/meetings/${MEETING_ID}/end`);
  });
});

describe('meeting-lifecycle-client — fails closed on the session', () => {
  it('returns 401 with no fetch when there is no user', async () => {
    mockGetSession.mockResolvedValue({ accessToken: ACCESS_TOKEN });

    await expect(endMeeting(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 401,
      code: 'unauthenticated',
    });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('returns 401 with no fetch when the access token is absent or empty', async () => {
    for (const accessToken of [undefined, '']) {
      mockGetSession.mockResolvedValue({ user: { id: 'user_1' }, accessToken });
      await expect(getMeetingState(MEETING_ID)).resolves.toMatchObject({ status: 401 });
    }
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });
});

describe('meeting-lifecycle-client — nothing throws, and every failure is typed', () => {
  it('maps the api error literal onto `code`', async () => {
    mockLoggedFetch.mockResolvedValue(response(404, { error: 'meeting_not_found' }));

    await expect(endMeeting(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 404,
      code: 'meeting_not_found',
    });
  });

  it('falls back to `request_failed` when the body names no error', async () => {
    mockLoggedFetch.mockResolvedValue(response(500, { unexpected: true }));

    await expect(getMeetingState(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 500,
      code: 'request_failed',
    });
  });

  it('⚠⚠ `status: 0` IS THE TRANSPORT SENTINEL — a dropped connection, not a verdict', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('ECONNRESET'));

    await expect(endMeeting(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 0,
      code: 'request_failed',
    });
    expect(log.error).toHaveBeenCalled();
  });

  it('⚠ tolerates an empty and a non-JSON body without throwing', async () => {
    mockLoggedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
    } as unknown as Response);
    await expect(getMeetingState(MEETING_ID)).resolves.toEqual({ ok: true, data: {} });

    mockLoggedFetch.mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: async () => '<html>Bad Gateway</html>',
    } as unknown as Response);
    await expect(getMeetingState(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 502,
      code: 'request_failed',
    });
  });

  it('⚠ NO LOG LINE CARRIES THE ACCESS TOKEN', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('boom'));
    await endMeeting(MEETING_ID);

    const logged = JSON.stringify([
      ...vi.mocked(log.error).mock.calls,
      ...vi.mocked(log.warn).mock.calls,
      ...vi.mocked(log.info).mock.calls,
    ]);
    expect(logged).not.toContain(ACCESS_TOKEN);
  });
});

describe('meeting-lifecycle-client — Retry-After', () => {
  it('reads it on a 429, clamped to five minutes', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '30' })
    );
    await expect(getMeetingState(MEETING_ID)).resolves.toMatchObject({ retryAfterSeconds: 30 });

    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '99999' })
    );
    await expect(getMeetingState(MEETING_ID)).resolves.toMatchObject({ retryAfterSeconds: 300 });
  });

  it('⚠ IGNORES it on any other status — an unrelated upstream is not advice about our window', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(503, { error: 'unavailable' }, { 'Retry-After': '30' })
    );

    const result = await getMeetingState(MEETING_ID);
    expect(result).not.toHaveProperty('retryAfterSeconds');
  });

  it('⚠ ignores a negative, zero or unparseable value', async () => {
    for (const raw of ['-5', '0', 'soon']) {
      mockLoggedFetch.mockResolvedValue(
        response(429, { error: 'rate_limited' }, { 'Retry-After': raw })
      );
      const result = await getMeetingState(MEETING_ID);
      // ⚠ THE KEY IS OMITTED, NOT SET TO `undefined` — a present-but-undefined optional survives
      // an `in` check and violates the declared type under `exactOptionalPropertyTypes`.
      expect(result).not.toHaveProperty('retryAfterSeconds');
    }
  });
});

describe('endMeeting — the response shape', () => {
  it('surfaces `alreadyEnded` so the caller can treat D10 as a SUCCESS', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(200, { status: 'ended', alreadyEnded: true, endedBy: 'expert_host' })
    );

    await expect(endMeeting(MEETING_ID)).resolves.toEqual({
      ok: true,
      data: { status: 'ended', alreadyEnded: true, endedBy: 'expert_host' },
    });
  });
});
