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
import { containsEmailAddress } from '@/test/contains-email-address';
import {
  decideMeetingGuestAdmission,
  getMeetingGuests,
  inviteMeetingGuests,
  resendMeetingGuestLink,
} from './guests-api-client';

/**
 * BAL-436 — the server-only web→api hop for the four guest operations.
 *
 * ⚠⚠ THE THREE PROPERTIES THIS FILE HOLDS:
 *   1. **NOTHING THROWS.** An exception escaping a Server Action becomes a Next error
 *      boundary, which is the wrong shape for "that person is no longer in the list".
 *   2. **`status: 0` IS THE TRANSPORT SENTINEL**, distinct from every verdict, because the
 *      poll must keep its schedule on a blip and stop on a `404`.
 *   3. **THE INVITE NEVER SENDS `party` OR `accessScope`** — both are server-derived, and a
 *      body field for either would be a cross-party write.
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
  mockLoggedFetch.mockResolvedValue(response(200, { guests: [], canHost: false }));
});

describe('the Bearer hop', () => {
  it('forwards the viewer`s WorkOS access token, resolved SERVER-SIDE', async () => {
    await getMeetingGuests(MEETING_ID);

    expect(mockLoggedFetch).toHaveBeenCalledWith(
      `http://api.test/meetings/${MEETING_ID}/guests`,
      expect.objectContaining({ service: 'balo-api', method: 'GET' })
    );
    expect(lastInit().headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('⚠ FAILS CLOSED on a session with no access token — never an unauthenticated call', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });

    const result = await getMeetingGuests(MEETING_ID);

    expect(result).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('⚠ FAILS CLOSED on a session with no user', async () => {
    mockGetSession.mockResolvedValue({ accessToken: ACCESS_TOKEN });

    await expect(getMeetingGuests(MEETING_ID)).resolves.toMatchObject({ status: 401 });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('falls back to localhost:3002 with no API_URL — ⚠ 3002, not CLAUDE.md`s stale 3001', async () => {
    delete process.env.API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;

    await getMeetingGuests(MEETING_ID);

    expect(mockLoggedFetch.mock.calls.at(-1)?.[0]).toBe(
      `http://localhost:3002/meetings/${MEETING_ID}/guests`
    );
  });
});

describe('failure handling — ⚠⚠ NOTHING THROWS', () => {
  it('⚠ `status: 0` IS THE TRANSPORT SENTINEL when the fetch itself rejects', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('ECONNRESET'));

    const result = await getMeetingGuests(MEETING_ID);

    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
  });

  /**
   * ⚠⚠ SWEPT OVER THE **INVITE**, NOT THE READ — AND THAT IS THE WHOLE POINT.
   *
   * `getMeetingGuests` takes a meeting id and nothing else, so an address was never in scope on
   * that call: the sweep could not have failed and therefore proved nothing. `inviteMeetingGuests`
   * receives the addresses as an argument, so they are genuinely available to be logged, and a
   * `log.error(..., { emails })` here now fails.
   */
  it('⚠⚠ logs a transport failure WITHOUT the ADDRESSES IT WAS HANDED, or a token', async () => {
    const address = 'dana@northwind.example';
    mockLoggedFetch.mockRejectedValue(new Error('ECONNRESET'));

    await inviteMeetingGuests(MEETING_ID, [address]);

    const [, context] = vi.mocked(log.error).mock.calls.at(-1) ?? [];
    const serialised = JSON.stringify(context);
    expect(serialised).not.toContain(ACCESS_TOKEN);
    expect(serialised).not.toContain(address);
    expect(serialised).not.toContain('northwind.example');
    // ⚠ AN ADDRESS SHAPE, NOT A BARE `@`. The `stack` field legitimately contains
    // `@vitest/runner` paths, so a bare `@` check would fail on the test harness rather than
    // on a leak — and would be deleted rather than obeyed. The scan is linear and
    // non-regex: S5852 / `regexp/no-super-linear-move` fire on test files too.
    expect(containsEmailAddress(serialised)).toBe(false);
    // ⚠ THE BAIT IS REAL. Without this the sweep above could pass because the scan broke.
    expect(containsEmailAddress(address)).toBe(true);
  });

  it('reads the FIXED literal off an error body, and nothing else from it', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(409, { error: 'participant_cap_reached', detail: 'do not surface this prose' })
    );

    const result = await inviteMeetingGuests(MEETING_ID, ['dana@northwind.example']);

    expect(result).toEqual({ ok: false, status: 409, code: 'participant_cap_reached' });
    expect(JSON.stringify(result)).not.toContain('do not surface this prose');
  });

  it('degrades to `request_failed` when a body carries no literal at all', async () => {
    mockLoggedFetch.mockResolvedValue(response(500, {}));

    await expect(getMeetingGuests(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 500,
      code: 'request_failed',
    });
  });

  it('survives a body that is not JSON', async () => {
    mockLoggedFetch.mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: async () => '<html>bad gateway</html>',
    } as unknown as Response);

    await expect(getMeetingGuests(MEETING_ID)).resolves.toMatchObject({
      ok: false,
      status: 502,
      code: 'request_failed',
    });
  });
});

describe('Retry-After', () => {
  it('reads it on a 429', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '90' })
    );

    await expect(resendMeetingGuestLink(MEETING_ID, GUEST_ID)).resolves.toEqual({
      ok: false,
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 90,
    });
  });

  it('⚠ IGNORES it on any other status — an unrelated upstream`s opinion is not our window', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(503, { error: 'rate_limit_unavailable' }, { 'Retry-After': '90' })
    );

    const result = await resendMeetingGuestLink(MEETING_ID, GUEST_ID);

    expect('retryAfterSeconds' in result).toBe(false);
  });

  it('⚠ CLAMPS an absurd cooldown to 300s and drops an unusable one — key ABSENT, not undefined', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '99999' })
    );
    await expect(resendMeetingGuestLink(MEETING_ID, GUEST_ID)).resolves.toMatchObject({
      retryAfterSeconds: 300,
    });

    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': 'soon' })
    );
    expect('retryAfterSeconds' in (await resendMeetingGuestLink(MEETING_ID, GUEST_ID))).toBe(false);
  });
});

describe('inviteMeetingGuests', () => {
  it('⚠⚠ NEVER sends `party` or `accessScope`, and always sends `entryPoint: in_call`', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(201, { guests: [{ id: GUEST_ID }], participantCount: 3, participantCap: 10 })
    );

    await inviteMeetingGuests(MEETING_ID, ['dana@northwind.example']);

    const body = JSON.parse(lastInit().body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      entryPoint: 'in_call',
      guests: [{ email: 'dana@northwind.example' }],
    });
    expect(JSON.stringify(body)).not.toContain('party');
    expect(JSON.stringify(body)).not.toContain('accessScope');
  });

  it('sends every address in one batch', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(201, { guests: [], participantCount: 3, participantCap: 10 })
    );

    await inviteMeetingGuests(MEETING_ID, ['a@x.example', 'b@x.example']);

    const body = JSON.parse(lastInit().body ?? '{}') as { guests: unknown[] };
    expect(body.guests).toHaveLength(2);
  });
});

describe('decideMeetingGuestAdmission', () => {
  it.each(['admit' as const, 'deny' as const])('POSTs to the /%s suffix', async (decision) => {
    mockLoggedFetch.mockResolvedValue(response(200, { id: GUEST_ID }));

    await decideMeetingGuestAdmission(MEETING_ID, GUEST_ID, decision);

    expect(mockLoggedFetch.mock.calls.at(-1)?.[0]).toBe(
      `http://api.test/meetings/${MEETING_ID}/guests/${GUEST_ID}/${decision}`
    );
    expect(lastInit().method).toBe('POST');
  });

  it('surfaces the race literal unchanged for the action layer to map', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'guest_not_pending' }));

    await expect(decideMeetingGuestAdmission(MEETING_ID, GUEST_ID, 'admit')).resolves.toMatchObject(
      { status: 409, code: 'guest_not_pending' }
    );
  });
});

describe('resendMeetingGuestLink', () => {
  it('POSTs to the resend-link suffix and returns the (tokenless) body', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(200, { id: GUEST_ID, expiresAt: '2026-09-08T11:00:00.000Z' })
    );

    const result = await resendMeetingGuestLink(MEETING_ID, GUEST_ID);

    expect(mockLoggedFetch.mock.calls.at(-1)?.[0]).toBe(
      `http://api.test/meetings/${MEETING_ID}/guests/${GUEST_ID}/resend-link`
    );
    expect(result).toEqual({
      ok: true,
      data: { id: GUEST_ID, expiresAt: '2026-09-08T11:00:00.000Z' },
    });
  });

  it('maps the not-resendable conflict to its literal', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'guest_link_not_resendable' }));

    await expect(resendMeetingGuestLink(MEETING_ID, GUEST_ID)).resolves.toMatchObject({
      status: 409,
      code: 'guest_link_not_resendable',
    });
  });
});
