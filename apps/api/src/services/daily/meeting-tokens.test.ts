import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, TEST_DAILY_API_KEY, useDailyApiKey } from '../../test/mocks/daily.js';
import { DAILY_API_BASE } from './client.js';
import { DailyApiError, DailyConfigError } from './errors.js';
import { createMeetingToken, dailyMeetingTokenMinter } from './meeting-tokens.js';

const ROOM = 'balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';
const PARTICIPANT_ID = 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';
/** 2026-09-01T11:00:00Z + 24h, in SECONDS. */
const EXPIRES_AT_UNIX = 1_788_346_800;

const REQUEST = {
  roomName: ROOM,
  userName: 'Dana Okoro',
  participantId: PARTICIPANT_ID,
  isOwner: true,
  expiresAtUnix: EXPIRES_AT_UNIX,
} as const;

useDailyApiKey();

/** Install a `fetch` returning one 2xx token payload, and hand back the spy. */
function stubMint(body: unknown = { token: 'daily.jwt.value' }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('createMeetingToken — the request', () => {
  it('⚠ POSTs a body that deep-equals EXACTLY the five documented `properties` keys', async () => {
    // ⚠⚠ THE PIN. Any EXTRA key here is a silent product commitment owned by BAL-435 (UI
    // knobs) or BAL-131 (webhooks), not by this ticket — the exact failure mode `rooms.ts`
    // records for `enable_knocking`. A regression in EITHER direction must fail loudly, so
    // this is a deep equality and not an `objectContaining`.
    const fetchMock = stubMint();

    await createMeetingToken(REQUEST);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/meeting-tokens`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      properties: {
        room_name: ROOM,
        user_name: 'Dana Okoro',
        user_id: PARTICIPANT_ID,
        is_owner: true,
        exp: EXPIRES_AT_UNIX,
      },
    });
  });

  it('⚠⚠ does NOT send `eject_at_token_exp` — the rejoin window depends on Daily`s default false', () => {
    // Setting it true would convert "your token stays valid for 24h so a network blip can
    // rejoin" into "you are ejected from a live call the instant it expires". Asserted as a
    // named absence as well as by the deep-equal above, so a failure says WHY.
    const fetchMock = stubMint();

    return createMeetingToken(REQUEST).then(() => {
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { properties: Record<string, unknown> };
      expect('eject_at_token_exp' in body.properties).toBe(false);
    });
  });

  it.each(['enable_screenshare', 'start_audio_off', 'start_video_off', 'enable_recording'])(
    'does NOT send `%s` — a Daily default, and BAL-435`s concern',
    async (key) => {
      const fetchMock = stubMint();

      await createMeetingToken(REQUEST);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { properties: Record<string, unknown> };
      expect(key in body.properties).toBe(false);
    }
  );

  it('sends the API key as a Bearer', async () => {
    const fetchMock = stubMint();

    await createMeetingToken(REQUEST);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TEST_DAILY_API_KEY}`);
  });

  it('passes `is_owner: false` through unchanged — the guest arm', async () => {
    const fetchMock = stubMint();

    await createMeetingToken({ ...REQUEST, isOwner: false, participantId: `g${'a'.repeat(32)}` });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { properties: Record<string, unknown> };
    expect(body.properties['is_owner']).toBe(false);
    expect(body.properties['user_id']).toBe(`g${'a'.repeat(32)}`);
  });

  it('sends `exp` as the caller`s number, unmodified — no unit conversion happens here', async () => {
    // The seconds-vs-milliseconds decision belongs to `meeting-liveness.ts` and is asserted
    // there. This module must not "helpfully" divide, or the two would each half-do it.
    const fetchMock = stubMint();

    await createMeetingToken(REQUEST);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { properties: Record<string, unknown> };
    expect(body.properties['exp']).toBe(EXPIRES_AT_UNIX);
  });
});

describe('createMeetingToken — the response must actually CARRY a credential', () => {
  it('returns the vendor`s token', async () => {
    stubMint({ token: 'daily.jwt.value' });

    await expect(createMeetingToken(REQUEST)).resolves.toEqual({ token: 'daily.jwt.value' });
  });

  it('REJECTS a 2xx with NO token — `as T` cannot catch this and a browser would get `undefined`', async () => {
    stubMint({});

    const error = await createMeetingToken(REQUEST).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ status: 0, method: 'POST', path: '/meeting-tokens' });
  });

  it('REJECTS an EMPTY-STRING token — a blank credential is as unusable as a missing one', async () => {
    stubMint({ token: '' });

    await expect(createMeetingToken(REQUEST)).rejects.toBeInstanceOf(DailyApiError);
  });

  it('uses status 0, NOT a real HTTP status — this is OUR verdict on a 2xx', async () => {
    stubMint({});

    const error = await createMeetingToken(REQUEST).catch((caught: unknown) => caught);

    expect((error as DailyApiError).status).toBe(0);
  });

  it('⚠ names the ROOM in the error body and NEVER the token value', async () => {
    // `DailyApiError.body` reaches the server log. A credential has no business in one, even
    // a truncated one — same rule as `rooms.ts`'s `requireField`.
    //
    // ⚠ ONE `stubMint`, NOT TWO. `vi.stubGlobal` REPLACES the global; it does not queue
    // responses, so a first call here was dead code that never reached `fetch`. The single
    // stub below is the one that runs: an empty `token` forces the failure path, and the
    // secret-shaped sibling key is what the assertion proves never reaches the error body.
    stubMint({ token: '', unusedSecret: 'super-secret-jwt' });

    const error = await createMeetingToken(REQUEST).catch((caught: unknown) => caught);

    const body = (error as DailyApiError).body;
    expect(body).toContain(ROOM);
    expect(body).not.toContain('super-secret-jwt');
  });
});

describe('createMeetingToken — vendor and configuration failures', () => {
  it('propagates a non-2xx status unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' })));

    const error = await createMeetingToken(REQUEST).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ status: 401 });
  });

  it('makes exactly ONE attempt — there is no retry loop, by ruling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createMeetingToken(REQUEST)).rejects.toBeInstanceOf(DailyApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws DailyConfigError when DAILY_API_KEY is unset — and IMPORTING the module did not', async () => {
    // The lazy read is what keeps this module importable in every route test on a machine
    // with no Daily account. If the key were a module-level const, this suite could not even
    // load. Reaching this assertion at all is half the proof.
    delete process.env.DAILY_API_KEY;
    vi.stubGlobal('fetch', vi.fn());

    await expect(createMeetingToken(REQUEST)).rejects.toBeInstanceOf(DailyConfigError);
  });
});

describe('dailyMeetingTokenMinter', () => {
  it('satisfies the MeetingTokenMinter port with the live createMeetingToken', () => {
    expect(dailyMeetingTokenMinter.createMeetingToken).toBe(createMeetingToken);
  });
});
