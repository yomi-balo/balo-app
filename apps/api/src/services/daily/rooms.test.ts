import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, useDailyApiKey } from '../../test/mocks/daily.js';
import { DAILY_API_BASE } from './client.js';
import { DailyApiError } from './errors.js';
import {
  createRoom,
  dailyPresenceReader,
  dailyRoomProvisioner,
  dailyRoomTeardown,
  deleteRoom,
  getAllPresence,
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

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ method: 'POST', path: '/rooms' });
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

    expect(error).toBeInstanceOf(DailyApiError);
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

    expect(error).toBeInstanceOf(DailyApiError);
    expect(error).toMatchObject({ method: 'GET', path: `/rooms/${ROOM}` });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['public', 'org', 'PRIVATE', ''])(
    'REJECTS privacy "%s" — only the exact string "private" is accepted',
    async (privacy) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM, privacy))));

      await expect(createRoom(ROOM)).rejects.toBeInstanceOf(DailyApiError);
    }
  );

  it('does NOT probe with a GET after a privacy rejection on the create path', async () => {
    // The thrown error deliberately carries a status that is NOT 400, so it cannot be mistaken
    // for the already-exists signal and trigger a pointless second call.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM, 'public')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createRoom(ROOM)).rejects.toBeInstanceOf(DailyApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries the offending privacy value in the error body, for the SERVER log only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, room(ROOM, 'public'))));

    const error = await createRoom(ROOM).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DailyApiError);
    expect((error as DailyApiError).body).toContain('public');
  });
});

describe('createRoom — the response must actually CARRY a venue (no half-stamped meeting)', () => {
  /**
   * ⚠ WHAT THIS BLOCK PREVENTS, END TO END. `client.ts`'s `dailyRequest` ends in a bare `as T`,
   * so a 2xx body of `{ name, privacy: 'private' }` with NO `url` type-checks and produces
   * `joinUrl: undefined`. `updateLiveMeeting` patches with `{ ...set, updatedAt }` and Drizzle
   * OMITS undefined keys — so `daily_room_name` gets stamped, `join_url` stays NULL, and
   * `provisionMeeting`'s replay guard (BOTH columns non-null) reads that meeting as
   * unprovisioned FOREVER: every repair re-GETs the room, re-stamps the same one column, and
   * never converges. `provision-meeting.ts` claims a half-stamped row is not producible through
   * the seam; THESE tests are what make that claim true rather than aspirational.
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
   * faithfully; deciding whether to ACT on it is the sweep's sanity gate, not this function's.
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

describe('the BAL-134 ports', () => {
  it('dailyRoomTeardown satisfies RoomTeardown with the live deleteRoom', () => {
    expect(dailyRoomTeardown.deleteRoom).toBe(deleteRoom);
  });

  it('dailyPresenceReader satisfies PresenceReader with the live getAllPresence', () => {
    expect(dailyPresenceReader.getAllPresence).toBe(getAllPresence);
  });
});
