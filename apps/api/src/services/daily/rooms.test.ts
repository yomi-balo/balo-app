import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, useDailyApiKey } from '../../test/mocks/daily.js';
import { DAILY_API_BASE } from './client.js';
import { DailyApiError, DailyRoomNotPrivateError } from './errors.js';
import {
  createRoom,
  dailyParticipantEjector,
  dailyPresenceReader,
  dailyRoomProvisioner,
  dailyRoomTeardown,
  deleteRoom,
  ejectParticipants,
  getAllPresence,
  getRoomPresence,
  getRoomSessionLeaves,
  DAILY_EJECT_MAX_IDS,
} from './rooms.js';

const ROOM = 'balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';

/** The shape Daily returns for a room we care about. */
function room(name: string, privacy = 'private'): { name: string; url: string; privacy: string } {
  return { name, url: `https://balo.daily.co/${name}`, privacy };
}

useDailyApiKey();

describe('createRoom — the request', () => {
  it('POSTs a body that deep-equals EXACTLY { name, privacy: "private", properties: { enable_recording: "cloud" } }', async () => {
    // ⚠ PIN. `privacy: 'private'` is what makes ADR-1044's app-side waiting-to-join queue
    // real — a public room's raw daily.co URL bypasses it entirely. `enable_recording:'cloud'`
    // is BAL-473's D5 always-on platform guarantee — the ONE other knob that earned its way
    // into this body (see the module docblock for why). Any OTHER extra key here would be a
    // silent product commitment owned by BAL-131/BAL-132, not this ticket. A regression in
    // any direction must fail loudly, so this is a deep equality, not an `objectContaining`.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM)));
    vi.stubGlobal('fetch', fetchMock);

    await createRoom(ROOM);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      name: ROOM,
      privacy: 'private',
      properties: { enable_recording: 'cloud' },
    });
  });

  it('returns the created room as a ProvisionedRoom', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM))));

    await expect(createRoom(ROOM)).resolves.toEqual({
      dailyRoomName: ROOM,
      joinUrl: `https://balo.daily.co/${ROOM}`,
    });
  });
});

describe('createRoom — the already-exists fallback (BAL-473: reconcile, then GET)', () => {
  it('resolves a 400 by RECONCILING enable_recording onto the existing room (OD-3)', async () => {
    // This is the net-new seam BAL-473 requires: without it, every room provisioned before
    // this ticket shipped would keep `enable_recording` unset and silently never record.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid-request-error' }))
      .mockResolvedValueOnce(jsonResponse(200, room(ROOM)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom(ROOM)).resolves.toEqual({
      dailyRoomName: ROOM,
      joinUrl: `https://balo.daily.co/${ROOM}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [reconcileUrl, reconcileInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(reconcileUrl).toBe(`${DAILY_API_BASE}/rooms/${ROOM}`);
    expect(reconcileInit.method).toBe('POST');
    // ⚠ PIN. The reconcile body carries ONLY the recording knob — never `privacy` (this call
    // is not creating the room) and never any other property.
    expect(JSON.parse(String(reconcileInit.body))).toEqual({
      properties: { enable_recording: 'cloud' },
    });
  });

  it('falls back to GET adoption when the reconcile call THROWS', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid-request-error' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' }))
      .mockResolvedValueOnce(jsonResponse(200, room(ROOM)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom(ROOM)).resolves.toEqual({
      dailyRoomName: ROOM,
      joinUrl: `https://balo.daily.co/${ROOM}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [getUrl, getInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(getUrl).toBe(`${DAILY_API_BASE}/rooms/${ROOM}`);
    expect(getInit.method).toBe('GET');
  });

  it('falls back to GET adoption when the reconcile returns a 2xx body missing name/url/privacy', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid-request-error' }))
      .mockResolvedValueOnce(jsonResponse(200, { name: ROOM, privacy: 'private' })) // no `url`
      .mockResolvedValueOnce(jsonResponse(200, room(ROOM)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom(ROOM)).resolves.toEqual({
      dailyRoomName: ROOM,
      joinUrl: `https://balo.daily.co/${ROOM}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [getUrl, getInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(getUrl).toBe(`${DAILY_API_BASE}/rooms/${ROOM}`);
    expect(getInit.method).toBe('GET');
  });

  it('rethrows the ORIGINAL 400 when BOTH the reconcile AND the GET fail', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'name-too-long' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' }))
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not-found' }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    // The ORIGINAL error, not the reconcile's or the GET's — both are diagnostics, and
    // reporting either status would misdiagnose the real failure.
    expect(error).toMatchObject({ status: 400, method: 'POST', path: '/rooms' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT attempt a reconcile or a GET on a non-400 failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes exactly ONE create attempt — there is no retry loop, by ruling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom(ROOM)).rejects.toBeInstanceOf(DailyApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createRoom — `privacy` is VERIFIED on the RESPONSE, not assumed (D8)', () => {
  /**
   * ⚠ WHY THIS BLOCK EXISTS. `privacy` was declared on the response type and never read on
   * either path, so the D8 guarantee that `rooms.ts`, `dailyRoomNameForMeeting` and the
   * route's "returning a joinUrl is safe" comment all rest on was enforced NOWHERE. Sending
   * `privacy: 'private'` on the POST proves nothing about what came back, and the
   * already-exists fallback does not send it at all — it ADOPTS a room whose privacy this code
   * never chose (dashboard-created, a public domain default, a future BAL-131/132 path). A
   * public room's raw `daily.co` URL needs no token and bypasses the app-side waiting queue
   * entirely, so a stamped-but-public room must fail LOUDLY rather than return a working URL.
   */
  it('REJECTS a created room the vendor returned as public', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM, 'public'))));

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    // A DailyRoomNotPrivateError IS a DailyApiError (the subclass keeps every existing
    // `instanceof DailyApiError` check holding).
    expect(error).toBeInstanceOf(DailyRoomNotPrivateError);
    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({
      name: 'DailyRoomNotPrivateError',
      method: 'POST',
      path: '/rooms',
    });
  });

  it('REJECTS an already-EXISTING room that is public — reconciled but never adopted', async () => {
    // The most important case: this is the path that never asks for `private` in the first
    // place, so before the assertion it would happily stamp a public room and hand back a
    // join URL that admits anybody who can guess a meeting id. The reconcile ONLY touches
    // `enable_recording` — it must not weaken the privacy assertion.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid-request-error' }))
      .mockResolvedValueOnce(jsonResponse(200, room(ROOM, 'public')));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyRoomNotPrivateError);
    // Attributed to the reconcile POST — that is where the offending room was seen.
    expect(error).toMatchObject({ method: 'POST', path: `/rooms/${ROOM}` });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('REJECTS an already-EXISTING public room reached via the GET fallback too', async () => {
    // Same privacy guarantee on the SECOND fallback leg — reached when the reconcile itself
    // fails and the GET adopts a public room.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid-request-error' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' }))
      .mockResolvedValueOnce(jsonResponse(200, room(ROOM, 'public')));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyRoomNotPrivateError);
    expect(error).toMatchObject({ method: 'GET', path: `/rooms/${ROOM}` });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['public', 'org', 'PRIVATE', ''])(
    'REJECTS privacy "%s" — only the exact string "private" is accepted',
    async (privacy) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM, privacy))));

      await expect(createRoom(ROOM)).rejects.toBeInstanceOf(DailyRoomNotPrivateError);
    }
  );

  it('does NOT probe with a GET after a privacy rejection on the create path', async () => {
    // The thrown error deliberately carries a status that is NOT 400, so it cannot be mistaken
    // for the already-exists signal and trigger a pointless second call.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM, 'public')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom(ROOM)).rejects.toBeInstanceOf(DailyRoomNotPrivateError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries the offending privacy value in the error body, for the SERVER log only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM, 'public'))));

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyRoomNotPrivateError);
    expect((error as DailyApiError).body).toContain('public');
  });
});

describe('createRoom — the response must actually CARRY a venue (no half-stamped meeting)', () => {
  /**
   * ⚠ WHAT THIS BLOCK PREVENTS, END TO END. `client.ts`'s `dailyRequest` ends in a bare `as T`,
   * so a 2xx body of `{ name, privacy: 'private' }` with NO `url` type-checks and produces
   * `joinUrl: undefined`. `updateLiveMeeting` patches with `{ ...set, updatedAt }` and Drizzle
   * OMITS undefined keys — so `daily_room_name` gets stamped, `join_url` stays NULL, and
   * `provisionMeeting`'s replay guard (venue-ready per `isMeetingVenueReady` — both columns AND
   * `daily_room_name === dailyRoomNameForMeeting(id)`) reads that meeting as unprovisioned
   * FOREVER: every repair re-GETs the room, re-stamps the same one column, and never converges.
   * `provision-meeting.ts` claims a half-stamped row is not producible through the seam; THESE
   * tests are what make that claim true rather than aspirational.
   */
  /** The vendor's room payload with one field ABSENT — the shape `as T` cannot catch. */
  function roomWithout(field: 'url' | 'name', privacy = 'private'): Record<string, string> {
    const partial: Record<string, string> = { ...room(ROOM, privacy) };
    delete partial[field];
    return partial;
  }

  it.each(['url', 'name'] as const)('REJECTS a 2xx create response missing `%s`', async (field) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, roomWithout(field))));

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ method: 'POST', path: '/rooms' });
    expect((error as DailyApiError).body).toContain(field);
  });

  it.each(['url', 'name'] as const)(
    'REJECTS an EMPTY `%s` — a blank string is as unusable as a missing one',
    async (field) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { ...room(ROOM), [field]: '' }))
      );

      await expect(createRoom(ROOM)).rejects.toBeInstanceOf(DailyApiError);
    }
  );

  it('REJECTS a missing `url` on the GET-fallback path too — it stamps the same two columns', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid-request-error' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'internal' })) // reconcile fails too
      .mockResolvedValueOnce(jsonResponse(200, roomWithout('url')));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    // Attributed to the GET — that is the call whose response was unusable.
    expect(error).toMatchObject({ method: 'GET', path: `/rooms/${ROOM}` });
  });

  it('does NOT probe with a GET after a field rejection on the create path', async () => {
    // Same reasoning as the privacy rejection: the thrown status is deliberately NOT 400, so it
    // cannot be mistaken for the already-exists signal.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, roomWithout('url')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom(ROOM)).rejects.toBeInstanceOf(DailyApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks privacy BEFORE the fields — a public room with no url reports the privacy fault', async () => {
    // Ordering matters for triage: "we refused a public room" is the security-relevant verdict
    // and must not be masked by a co-occurring shape problem.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, roomWithout('url', 'public')))
    );

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect((error as DailyApiError).body).toContain('public');
  });
});

describe('dailyRoomProvisioner', () => {
  it('satisfies the RoomProvisioner port with the live createRoom', () => {
    expect(dailyRoomProvisioner.createRoom).toBe(createRoom);
  });
});

// ── BAL-134 — TEARDOWN AND RECONCILIATION ─────────────────────────────────────────────────

describe('deleteRoom (BAL-134)', () => {
  it('issues DELETE /rooms/:name and reports `deleted`', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { deleted: true, name: ROOM }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteRoom(ROOM)).resolves.toBe('deleted');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/${ROOM}`);
    expect(init.method).toBe('DELETE');
    // ⚠ NO BODY. A DELETE carrying a JSON body would also set Content-Type — exactly the kind
    // of silent request-shape change `createRoom`'s deep-equal pin exists to prevent.
    expect(init.body).toBeUndefined();
  });

  /**
   * ⚠ A 404 IS SUCCESS. Daily auto-deletes an expiring room once the last participant leaves,
   * so racing that is the NORMAL path — and the caller's goal ("the room is gone") is met.
   */
  it('⚠ maps 404 to `already_gone` rather than throwing — the room being gone IS the goal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not-found' })));

    await expect(deleteRoom(ROOM)).resolves.toBe('already_gone');
  });

  it('⚠ rethrows a 429 — there is deliberately NO retry loop; the sweep retries next tick', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate-limited' })));

    const error = await deleteRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ status: 429, method: 'DELETE' });
  });

  it('rethrows any other non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    await expect(deleteRoom(ROOM)).rejects.toBeInstanceOf(DailyApiError);
  });

  it('percent-encodes the room name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await deleteRoom('balo room/1');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/balo%20room%2F1`);
  });
});

describe('getAllPresence (BAL-134)', () => {
  it('GETs /presence ONCE for the whole platform and returns rooms → participants', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        [ROOM]: [{ userId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d', id: 'sess-1' }],
        'balo-other': [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAllPresence()).resolves.toEqual({
      [ROOM]: [{ userId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d', id: 'sess-1' }],
      'balo-other': [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/presence`);
    expect(init.method).toBe('GET');
  });

  /**
   * ⚠⚠ RE-DECIDED (S1). This used to assert that an unparseable room value was silently DROPPED
   * and the rest returned. That is the most dangerous possible answer here, because "fewer rooms
   * than reality" is indistinguishable downstream from "those rooms are empty": the sweep closes
   * every open interval it believes the vendor did not confirm, `idleEndApplies` ends every
   * `in_progress` meeting ~5 minutes later, and `tearDownRoom` deletes Daily rooms out from
   * under people who are still talking.
   *
   * A body this platform cannot interpret is now an ERROR, so the sweep's existing outage path
   * treats the whole tick as UNKNOWN and reconciles nothing. Skipping a repair is recoverable;
   * a confident wrong answer on a destructive path is not.
   */
  it('⚠⚠ THROWS on a body it cannot interpret — never a partial, confident-looking answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { [ROOM]: 'nonsense', 'balo-ok': [] }))
    );

    await expect(getAllPresence()).rejects.toMatchObject({
      name: 'DailyApiError',
      path: '/presence',
      body: expect.stringContaining('cannot interpret'),
    });
  });

  it('⚠ THROWS rather than answering `{}` when the body is not an object at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, ['not', 'a', 'map'])));

    await expect(getAllPresence()).rejects.toMatchObject({
      name: 'DailyApiError',
      body: expect.stringContaining('cannot interpret'),
    });
  });

  /**
   * ⚠ AN EMPTY MAP IS A LEGITIMATE, WELL-FORMED ANSWER — nobody is on any call. It is returned
   * faithfully; what it licenses is the sweep's decision (an absent room still needs a per-room
   * read before anything is closed), not this function's.
   */
  it('answers an empty map for an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})));

    await expect(getAllPresence()).resolves.toEqual({});
  });

  it('strips vendor keys this platform has not named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          [ROOM]: [{ userId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d', unexpected: 'field' }],
        })
      )
    );

    await expect(getAllPresence()).resolves.toEqual({
      [ROOM]: [{ userId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d' }],
    });
  });
});

describe('getRoomPresence (BAL-584)', () => {
  const USER_ID = 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';

  function stubBody(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('parses the documented body and GETs the URL-encoded per-room path', async () => {
    const fetchMock = stubBody({
      total_count: 1,
      data: [
        {
          room: ROOM,
          id: 'sess-1',
          userId: USER_ID,
          userName: 'Dana',
          mtgSessionId: 'mtg-1',
          joinTime: '2026-10-07T01:00:00.000Z',
          duration: 2312,
        },
      ],
    });

    await expect(getRoomPresence(ROOM)).resolves.toEqual([
      { room: ROOM, id: 'sess-1', userId: USER_ID, joinTime: '2026-10-07T01:00:00.000Z' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/${ROOM}/presence`);
    expect(init.method).toBe('GET');
  });

  /**
   * Routes by URL: the presence path answers `presence`, the bare room path answers `roomResponse`
   * (a ready `Response`, so a test can make it a 404 or an unparseable body).
   */
  function stubRoutes(
    presence: unknown,
    roomResponse: (name: string) => Response
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/presence')) {
        return jsonResponse(200, presence);
      }
      return roomResponse(decodeURIComponent(url.slice(`${DAILY_API_BASE}/rooms/`.length)));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const EMPTY = { total_count: 0, data: [] };

  it('URL-encodes the room name into the path', async () => {
    const fetchMock = stubRoutes(EMPTY, (name) => jsonResponse(200, { name }));

    await getRoomPresence('balo room/1');

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      `${DAILY_API_BASE}/rooms/balo%20room%2F1/presence`,
      `${DAILY_API_BASE}/rooms/balo%20room%2F1`,
    ]);
  });

  it('answers [] for an empty presence list once GET /rooms/:name confirms the room exists', async () => {
    const fetchMock = stubRoutes(EMPTY, (name) => jsonResponse(200, { name, privacy: 'private' }));

    await expect(getRoomPresence(ROOM)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [roomUrl, roomInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(roomUrl).toBe(`${DAILY_API_BASE}/rooms/${ROOM}`);
    expect(roomInit.method).toBe('GET');
  });

  it('⚠⚠ THROWS for an empty presence list when the room does not exist (Daily answers 200 [] for it)', async () => {
    stubRoutes(EMPTY, () => jsonResponse(404, { error: 'not-found', info: 'room not found' }));

    await expect(getRoomPresence(ROOM)).rejects.toMatchObject({
      name: 'DailyApiError',
      status: 404,
      path: `/rooms/${ROOM}`,
    });
  });

  it.each([
    ['a name that is not the one asked for', { name: 'balo-other' }],
    ['a body with no name', { privacy: 'private' }],
    ['a body that is not an object', ['not', 'a', 'room']],
  ])(
    '⚠⚠ THROWS for an empty presence list when the room check returns %s',
    async (_label, body) => {
      stubRoutes(EMPTY, () => jsonResponse(200, body));

      await expect(getRoomPresence(ROOM)).rejects.toMatchObject({
        name: 'DailyApiError',
        status: 0,
        path: `/rooms/${ROOM}`,
        body: expect.stringContaining('cannot trust'),
      });
    }
  );

  it('does NOT call the room endpoint when the presence list is non-empty', async () => {
    const fetchMock = stubRoutes({ total_count: 1, data: [{ userId: USER_ID }] }, () => {
      throw new Error('the room endpoint must not be called');
    });

    await expect(getRoomPresence(ROOM)).resolves.toEqual([{ userId: USER_ID }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a row that omits `room`', async () => {
    stubBody({ total_count: 1, data: [{ userId: USER_ID }] });

    await expect(getRoomPresence(ROOM)).resolves.toEqual([{ userId: USER_ID }]);
  });

  /**
   * ⚠⚠ EVERY ONE OF THESE MUST THROW: an empty-looking return from this function is the licence
   * to close intervals with no identity match, so a body that cannot be trusted has to take the
   * UNKNOWN path instead.
   */
  it.each([
    ['a body that is not an object', ['not', 'an', 'envelope']],
    ['a missing data array', { total_count: 0 }],
    ['a non-array data', { total_count: 0, data: 'nonsense' }],
    ['a negative total_count', { total_count: -1, data: [] }],
    ['a non-integer total_count', { total_count: 0.5, data: [] }],
    ['a total_count above the rows returned (truncation)', { total_count: 3, data: [{}] }],
    ['a total_count below the rows returned', { total_count: 0, data: [{ userId: USER_ID }] }],
    [
      'a row naming a different room',
      { total_count: 1, data: [{ room: 'balo-other', userId: USER_ID }] },
    ],
  ])('⚠⚠ THROWS on %s', async (_label, body) => {
    stubBody(body);

    await expect(getRoomPresence(ROOM)).rejects.toMatchObject({
      name: 'DailyApiError',
      path: `/rooms/${ROOM}/presence`,
      body: expect.stringContaining('cannot trust'),
    });
  });

  it('propagates a 404 rather than reading a missing room as empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not-found', info: 'no such room' }))
    );

    await expect(getRoomPresence(ROOM)).rejects.toBeInstanceOf(DailyApiError);
    await expect(getRoomPresence(ROOM)).rejects.toMatchObject({ status: 404 });
  });
});

describe('getRoomSessionLeaves (BAL-584)', () => {
  const EXPERT = 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';
  const CLIENT = 'u9a8b7c6d5e4f4a3b8c2d1e0f9a8b7c6d';
  /** The incident room's shape: two participants whose recorded leaves land seconds apart. */
  const JOIN_SECONDS = 1_760_000_000;
  const SINCE = new Date((JOIN_SECONDS - 3600) * 1000);

  function session(
    participants: ReadonlyArray<Record<string, unknown>>,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      id: 'mtg-1',
      room: ROOM,
      start_time: JOIN_SECONDS,
      duration: 200,
      ongoing: false,
      participants,
      ...overrides,
    };
  }

  function stubSessions(data: unknown[], totalCount = data.length): ReturnType<typeof vi.fn> {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { total_count: totalCount, data }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('maps each user_id to join_time + duration, and never reads user_name', async () => {
    stubSessions([
      session([
        {
          user_id: EXPERT,
          participant_id: 'p1',
          user_name: 'Dana',
          join_time: JOIN_SECONDS,
          duration: 178,
        },
        {
          user_id: CLIENT,
          participant_id: 'p2',
          user_name: 'Sam',
          join_time: JOIN_SECONDS + 2,
          duration: 186,
        },
      ]),
    ]);

    const { leaves } = await getRoomSessionLeaves(ROOM, { since: SINCE });

    expect([...leaves.entries()]).toEqual([
      [EXPERT, new Date((JOIN_SECONDS + 178) * 1000)],
      [CLIENT, new Date((JOIN_SECONDS + 188) * 1000)],
    ]);
  });

  it('the LATEST recorded leave wins when a claim appears in several sessions', async () => {
    stubSessions([
      session([{ user_id: EXPERT, join_time: JOIN_SECONDS, duration: 600 }]),
      session([{ user_id: EXPERT, join_time: JOIN_SECONDS + 5000, duration: 60 }], { id: 'mtg-2' }),
      session([{ user_id: EXPERT, join_time: JOIN_SECONDS + 100, duration: 10 }], { id: 'mtg-3' }),
    ]);

    const { leaves } = await getRoomSessionLeaves(ROOM, { since: SINCE });

    expect(leaves.get(EXPERT)).toEqual(new Date((JOIN_SECONDS + 5060) * 1000));
  });

  it('skips a participant with no user_id, no join_time or no finite duration', async () => {
    stubSessions([
      session(
        [
          { user_id: null, join_time: JOIN_SECONDS, duration: 10 },
          { join_time: JOIN_SECONDS, duration: 10 },
          { user_id: EXPERT, join_time: JOIN_SECONDS },
          { user_id: CLIENT, duration: 10 },
        ],
        { ongoing: true }
      ),
    ]);

    const { leaves } = await getRoomSessionLeaves(ROOM, { since: SINCE });

    expect(leaves).toEqual(new Map());
  });

  it('answers an empty history for a room Daily has no record of', async () => {
    stubSessions([]);

    await expect(getRoomSessionLeaves(ROOM, { since: SINCE })).resolves.toEqual({
      leaves: new Map(),
      ongoingClaims: new Set(),
    });
  });

  it('⚠ names the claims that appear in an ongoing session, and only those', async () => {
    stubSessions([
      session([{ user_id: EXPERT, join_time: JOIN_SECONDS, duration: 60 }], { ongoing: false }),
      session([{ user_id: CLIENT, join_time: JOIN_SECONDS }, { join_time: JOIN_SECONDS }], {
        id: 'mtg-2',
        ongoing: true,
      }),
    ]);

    const { ongoingClaims } = await getRoomSessionLeaves(ROOM, { since: SINCE });

    expect([...ongoingClaims]).toEqual([CLIENT]);
  });

  it('URL-encodes the room and carries the time window and an explicit limit', async () => {
    const fetchMock = stubSessions([], 0);

    await getRoomSessionLeaves('balo room/1', { since: SINCE });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${DAILY_API_BASE}/meetings?room=balo%20room%2F1&timeframe_start=${JOIN_SECONDS - 3600}&limit=100`
    );
    expect(init.method).toBe('GET');
  });

  it.each([
    ['a body that is not an envelope', ['nope']],
    ['a missing data array', { total_count: 0 }],
    [
      'a non-numeric join_time',
      { total_count: 1, data: [session([{ user_id: EXPERT, join_time: 'noon' }])] },
    ],
    [
      'a total_count above the sessions returned (truncation)',
      { total_count: 3, data: [session([])] },
    ],
    [
      'a session naming a different room',
      { total_count: 1, data: [session([], { room: 'balo-other' })] },
    ],
  ])('⚠⚠ THROWS on %s', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, body)));

    await expect(getRoomSessionLeaves(ROOM, { since: SINCE })).rejects.toMatchObject({
      name: 'DailyApiError',
      status: 0,
      body: expect.stringContaining('cannot trust'),
    });
  });

  it('propagates a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate-limit' })));

    await expect(getRoomSessionLeaves(ROOM, { since: SINCE })).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('the BAL-134 ports', () => {
  it('dailyRoomTeardown satisfies RoomTeardown with the live deleteRoom', () => {
    expect(dailyRoomTeardown.deleteRoom).toBe(deleteRoom);
  });

  it('dailyPresenceReader satisfies PresenceReader with the live getAllPresence', () => {
    expect(dailyPresenceReader.getAllPresence).toBe(getAllPresence);
    expect(dailyPresenceReader.getRoomPresence).toBe(getRoomPresence);
    expect(dailyPresenceReader.getRoomSessionLeaves).toBe(getRoomSessionLeaves);
  });
});

// ── BAL-476 (R4) — the per-participant eject ──────────────────────────────────────────────

const PARTICIPANT = 'g0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';

describe('ejectParticipants (BAL-476)', () => {
  /**
   * ⚠ A DEEP-EQUAL BODY PIN, for the reason `createRoom`'s is one: **a wrong key is SILENTLY
   * IGNORED by Daily** (the recording-body trap). An `ids:` where `user_ids:` belongs, or a
   * dropped `ban`, would produce a perfectly healthy 200 and eject nobody / ban nobody.
   */
  it('⚠ POSTs a body that deep-equals EXACTLY { user_ids, ban: true } and nothing else', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(ejectParticipants(ROOM, [PARTICIPANT])).resolves.toBe('ejected');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/${ROOM}/eject`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ user_ids: [PARTICIPANT], ban: true });
  });

  /**
   * ⚠⚠ `ban: true` IS LOAD-BEARING. A Daily meeting token SURVIVES an eject
   * (`eject_at_token_exp: false`, `exp = scheduled_end + 24h`), so an un-banned eject buys
   * seconds. This is the assertion that fails if somebody "simplifies" it away.
   */
  it('⚠ always sends ban: true — an eject alone does not revoke the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await ejectParticipants(ROOM, [PARTICIPANT]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).ban).toBe(true);
  });

  it('⚠ maps 404 to `already_gone` — the room may have been reaped, or they may have left', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not-found' })));

    await expect(ejectParticipants(ROOM, [PARTICIPANT])).resolves.toBe('already_gone');
  });

  it('⚠ rethrows a 429 — there is deliberately NO retry loop; the caller is best-effort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate-limited' })));

    const error = await ejectParticipants(ROOM, [PARTICIPANT]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ status: 429, method: 'POST' });
  });

  it('rethrows any other non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    await expect(ejectParticipants(ROOM, [PARTICIPANT])).rejects.toBeInstanceOf(DailyApiError);
  });

  it('⚠ refuses more than Daily cap WITHOUT a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tooMany = Array.from({ length: DAILY_EJECT_MAX_IDS + 1 }, (_value, index) => `g${index}`);

    await expect(ejectParticipants(ROOM, tooMany)).rejects.toBeInstanceOf(DailyApiError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(DAILY_EJECT_MAX_IDS).toBe(100);
  });

  it('an empty id list is `already_gone` and makes no network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(ejectParticipants(ROOM, [])).resolves.toBe('already_gone');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('percent-encodes the room name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await ejectParticipants('balo room/1', [PARTICIPANT]);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/balo%20room%2F1/eject`);
  });

  it('dailyParticipantEjector satisfies ParticipantEjector with the live ejectParticipants', () => {
    expect(dailyParticipantEjector.ejectParticipants).toBe(ejectParticipants);
  });
});
