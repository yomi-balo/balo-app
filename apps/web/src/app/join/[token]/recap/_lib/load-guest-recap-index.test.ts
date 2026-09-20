import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const IP_HASH = 'f'.repeat(64);
const GUEST_ID = 'e0000000-0000-4000-8000-00000000000e';
const OWN_MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const CASE_CONTEXT_ID = 'c0000000-0000-4000-8000-000000000003';
const RELATIONSHIP_ID = 'd0000000-0000-4000-8000-000000000005';

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

const mockResolveSubject = vi.fn();
vi.mock('@/lib/meetings/resolve-meeting-guest', () => ({
  resolveMeetingGuestSubject: (...a: unknown[]) => mockResolveSubject(...a),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/meetings/resolve-guest-recap-access', () => ({
  resolveGuestRecapAccess: (...a: unknown[]) => mockResolveAccess(...a),
}));

const mockListMeetingsForContexts = vi.fn();
vi.mock('@balo/db', () => ({
  meetingContextsRepository: {
    listMeetingsForContexts: (...a: unknown[]) => mockListMeetingsForContexts(...a),
  },
}));

import { dedupedEndedMeetingIds, loadGuestRecapIndex } from './load-guest-recap-index';

function meetingRow(
  id: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    status: 'ended',
    scheduledStart: new Date('2026-08-01T10:00:00.000Z'),
    scheduledEnd: new Date('2026-08-01T11:00:00.000Z'),
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function subjectFor(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    guest: { id: GUEST_ID, accessScope: 'engagement', ...overrides },
    meeting: meetingRow(OWN_MEETING_ID),
    side: 'client',
    admission: 'admitted',
  };
}

function accessFor(
  meetingId: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    guestId: GUEST_ID,
    accessScope: 'engagement',
    meeting: meetingRow(meetingId),
    subject: { contextType: 'case', contextId: CASE_CONTEXT_ID },
    isOwnMeeting: meetingId === OWN_MEETING_ID,
    ...overrides,
  };
}

function candidate(
  meetingId: string,
  contextType: string,
  contextId: string,
  meetingOverrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return { meeting: meetingRow(meetingId, meetingOverrides), contextType, contextId };
}

function input(): { rawToken: string; clientIpHash: string } {
  return { rawToken: RAW_TOKEN, clientIpHash: IP_HASH };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReturnValue(true);
});

describe('loadGuestRecapIndex — throttling and ordering obligation', () => {
  it(':ip: limiter refuses ⇒ null, and resolveMeetingGuestSubject is NEVER called', async () => {
    mockCheckLimit.mockReturnValue(false);

    const result = await loadGuestRecapIndex(input());

    expect(result).toBeNull();
    expect(mockResolveSubject).not.toHaveBeenCalled();
  });

  it(':gid: limiter refuses ⇒ null, and resolveGuestRecapAccess is NEVER called', async () => {
    mockCheckLimit.mockImplementation((key: string) => !key.includes(':gid:'));
    mockResolveSubject.mockResolvedValue(subjectFor());

    const result = await loadGuestRecapIndex(input());

    expect(result).toBeNull();
    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('the two limiter keys are DISJOINT from the per-meeting recap`s guest-recap:ip:/:gid:', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor({ accessScope: 'meeting' }));

    await loadGuestRecapIndex(input());

    const keys = mockCheckLimit.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(`guest-recap-index:ip:${IP_HASH}`);
    expect(keys[1]).toBe(`guest-recap-index:gid:${GUEST_ID}`);
    for (const key of keys) {
      expect(key).not.toContain('guest-recap:ip:');
      expect(key).not.toContain('guest-recap:gid:');
    }
  });

  it('unresolvable token ⇒ null', async () => {
    mockResolveSubject.mockResolvedValue(null);

    const result = await loadGuestRecapIndex(input());

    expect(result).toBeNull();
  });
});

describe('loadGuestRecapIndex — D2, the meeting-scope redirect', () => {
  it('accessScope "meeting" ⇒ redirect to the own recap, ZERO gate/reverse-read calls', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor({ accessScope: 'meeting' }));

    const result = await loadGuestRecapIndex(input());

    expect(result).toEqual({
      kind: 'redirect',
      href: `/join/${RAW_TOKEN}/recap/${OWN_MEETING_ID}`,
    });
    expect(mockResolveAccess).not.toHaveBeenCalled();
    expect(mockListMeetingsForContexts).not.toHaveBeenCalled();
  });

  it('the redirect is NOT gated on ended — a scheduled own meeting still redirects', async () => {
    mockResolveSubject.mockResolvedValue({
      ...subjectFor({ accessScope: 'meeting' }),
      meeting: meetingRow(OWN_MEETING_ID, { status: 'scheduled' }),
    });

    const result = await loadGuestRecapIndex(input());

    expect(result).toEqual({
      kind: 'redirect',
      href: `/join/${RAW_TOKEN}/recap/${OWN_MEETING_ID}`,
    });
  });

  it('anchor gate returns null (pending admission) ⇒ null', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValue(null);

    const result = await loadGuestRecapIndex(input());

    expect(result).toBeNull();
  });

  it('a PENDING meeting-scope guest gets null (LinkNotActive), never the redirect', async () => {
    mockResolveSubject.mockResolvedValue({
      ...subjectFor({ accessScope: 'meeting' }),
      admission: 'pending',
    });

    const result = await loadGuestRecapIndex(input());

    expect(result).toBeNull();
    expect(mockResolveAccess).not.toHaveBeenCalled();
    expect(mockListMeetingsForContexts).not.toHaveBeenCalled();
  });

  it('a DENIED meeting-scope guest also gets null, never the redirect', async () => {
    mockResolveSubject.mockResolvedValue({
      ...subjectFor({ accessScope: 'meeting' }),
      admission: 'denied',
    });

    const result = await loadGuestRecapIndex(input());

    expect(result).toBeNull();
  });

  it('an ADMITTED meeting-scope guest still gets the redirect (non-vacuity)', async () => {
    mockResolveSubject.mockResolvedValue({
      ...subjectFor({ accessScope: 'meeting' }),
      admission: 'admitted',
    });

    const result = await loadGuestRecapIndex(input());

    expect(result).toEqual({
      kind: 'redirect',
      href: `/join/${RAW_TOKEN}/recap/${OWN_MEETING_ID}`,
    });
  });

  it('a PRE_ADMITTED meeting-scope guest also gets the redirect', async () => {
    mockResolveSubject.mockResolvedValue({
      ...subjectFor({ accessScope: 'meeting' }),
      admission: 'pre_admitted',
    });

    const result = await loadGuestRecapIndex(input());

    expect(result).toEqual({
      kind: 'redirect',
      href: `/join/${RAW_TOKEN}/recap/${OWN_MEETING_ID}`,
    });
  });
});

describe('loadGuestRecapIndex — the envelope null arm (project_discovery)', () => {
  it('envelope null ⇒ { kind: "index", rows: [] }, and listMeetingsForContexts is called ZERO times', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValue(
      accessFor(OWN_MEETING_ID, {
        subject: { contextType: 'project_discovery', contextId: 'req-1' },
      })
    );

    const result = await loadGuestRecapIndex(input());

    expect(result).toEqual({ kind: 'index', rows: [], guestId: GUEST_ID });
    expect(mockListMeetingsForContexts).not.toHaveBeenCalled();
  });
});

describe('loadGuestRecapIndex — the two envelope arms', () => {
  it('engagement arm — listMeetingsForContexts called once with the exact four pairs', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValue(accessFor(OWN_MEETING_ID));
    mockListMeetingsForContexts.mockResolvedValue([]);

    await loadGuestRecapIndex(input());

    expect(mockListMeetingsForContexts).toHaveBeenCalledTimes(1);
    expect(mockListMeetingsForContexts).toHaveBeenCalledWith([
      { contextType: 'case', contextId: CASE_CONTEXT_ID },
      { contextType: 'project_kickoff', contextId: CASE_CONTEXT_ID },
      { contextType: 'package_session', contextId: CASE_CONTEXT_ID },
      { contextType: 'retainer_checkin', contextId: CASE_CONTEXT_ID },
    ]);
  });

  it('relationship arm — called once with exactly [request_interaction]', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValue(
      accessFor(OWN_MEETING_ID, {
        subject: { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
      })
    );
    mockListMeetingsForContexts.mockResolvedValue([]);

    await loadGuestRecapIndex(input());

    expect(mockListMeetingsForContexts).toHaveBeenCalledTimes(1);
    expect(mockListMeetingsForContexts).toHaveBeenCalledWith([
      { contextType: 'request_interaction', contextId: RELATIONSHIP_ID },
    ]);
  });
});

describe('loadGuestRecapIndex — candidate filtering', () => {
  it('only ended candidates are gated', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID));

    const [endedId, scheduledId, cancelledId, inProgressId] = ['s1', 's2', 's3', 's4'];
    mockListMeetingsForContexts.mockResolvedValue([
      candidate(endedId, 'case', CASE_CONTEXT_ID, { status: 'ended' }),
      candidate(scheduledId, 'case', CASE_CONTEXT_ID, { status: 'scheduled' }),
      candidate(cancelledId, 'case', CASE_CONTEXT_ID, { status: 'cancelled' }),
      candidate(inProgressId, 'case', CASE_CONTEXT_ID, { status: 'in_progress' }),
    ]);
    mockResolveAccess.mockResolvedValueOnce(accessFor(endedId));

    const result = await loadGuestRecapIndex(input());

    expect(mockResolveAccess).toHaveBeenCalledTimes(2); // anchor + the one ended candidate
    expect(result?.kind === 'index' ? result.rows : []).toHaveLength(1);
  });

  it('de-dup — the same meeting.id under two context types is gated once', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID));

    const dupId = 'a0000000-0000-4000-8000-000000000099';
    mockListMeetingsForContexts.mockResolvedValue([
      candidate(dupId, 'case', CASE_CONTEXT_ID),
      candidate(dupId, 'package_session', CASE_CONTEXT_ID),
    ]);
    mockResolveAccess.mockResolvedValueOnce(accessFor(dupId));

    const result = await loadGuestRecapIndex(input());

    expect(mockResolveAccess).toHaveBeenCalledTimes(2); // anchor + ONE gate call for dupId
    expect(result?.kind === 'index' ? result.rows : []).toHaveLength(1);
  });

  it('per-row denial — ok/null/ok verdicts yield exactly the two ok rows', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID)); // anchor

    const [id1, id2, id3] = [
      'a0000000-0000-4000-8000-000000000011',
      'a0000000-0000-4000-8000-000000000012',
      'a0000000-0000-4000-8000-000000000013',
    ];
    mockListMeetingsForContexts.mockResolvedValue([
      candidate(id1, 'case', CASE_CONTEXT_ID),
      candidate(id2, 'case', CASE_CONTEXT_ID),
      candidate(id3, 'case', CASE_CONTEXT_ID),
    ]);
    mockResolveAccess.mockResolvedValueOnce(accessFor(id1));
    mockResolveAccess.mockResolvedValueOnce(null);
    mockResolveAccess.mockResolvedValueOnce(accessFor(id3));

    const result = await loadGuestRecapIndex(input());

    expect(result?.kind).toBe('index');
    const rows = result?.kind === 'index' ? result.rows : [];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.meetingId).sort((a, b) => a.localeCompare(b))).toEqual(
      [id1, id3].sort((a, b) => a.localeCompare(b))
    );
  });

  it('projection source — row fields come from the VERDICT, never the reverse read`s row', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID)); // anchor

    const canonicalId = 'a0000000-0000-4000-8000-000000000021';
    const reverseReadId = canonicalId.toUpperCase();
    mockListMeetingsForContexts.mockResolvedValue([
      // The reverse read's row disagrees on id casing AND scheduledStart from the verdict's own.
      candidate(reverseReadId, 'case', CASE_CONTEXT_ID, {
        id: reverseReadId,
        scheduledStart: new Date('2000-01-01T00:00:00.000Z'),
        status: 'ended',
      }),
    ]);
    mockResolveAccess.mockResolvedValueOnce(
      accessFor(canonicalId, {
        meeting: meetingRow(canonicalId, { scheduledStart: new Date('2026-08-01T10:00:00.000Z') }),
      })
    );

    const result = await loadGuestRecapIndex(input());
    const rows = result?.kind === 'index' ? result.rows : [];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.meetingId).toBe(canonicalId);
    expect(rows[0]?.occurredAtIso).toBe('2026-08-01T10:00:00.000Z');
  });

  it('ordering — most recent first, exact sequence', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID)); // anchor

    const [older, newest, middle] = [
      'a0000000-0000-4000-8000-000000000031',
      'a0000000-0000-4000-8000-000000000032',
      'a0000000-0000-4000-8000-000000000033',
    ];
    mockListMeetingsForContexts.mockResolvedValue([
      candidate(older, 'case', CASE_CONTEXT_ID),
      candidate(newest, 'case', CASE_CONTEXT_ID),
      candidate(middle, 'case', CASE_CONTEXT_ID),
    ]);
    mockResolveAccess.mockResolvedValueOnce(
      accessFor(older, {
        meeting: meetingRow(older, { scheduledStart: new Date('2025-01-01T00:00:00.000Z') }),
      })
    );
    mockResolveAccess.mockResolvedValueOnce(
      accessFor(newest, {
        meeting: meetingRow(newest, { startedAt: new Date('2026-09-01T00:00:00.000Z') }),
      })
    );
    mockResolveAccess.mockResolvedValueOnce(
      accessFor(middle, {
        meeting: meetingRow(middle, { scheduledStart: new Date('2026-06-01T00:00:00.000Z') }),
      })
    );

    const result = await loadGuestRecapIndex(input());
    const rows = result?.kind === 'index' ? result.rows : [];

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.meetingId)).toEqual([newest, middle, older]);
  });

  it('the cap — 30 ended candidates ⇒ gated exactly MAX_INDEX_CANDIDATES (24) times, the LAST 24', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID)); // anchor

    const ids = Array.from(
      { length: 30 },
      (_, i) => `a0000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
    );
    mockListMeetingsForContexts.mockResolvedValue(
      ids.map((id) => candidate(id, 'case', CASE_CONTEXT_ID))
    );
    for (const id of ids) {
      mockResolveAccess.mockResolvedValueOnce(accessFor(id));
    }

    await loadGuestRecapIndex(input());

    // anchor call + 24 gated candidate calls
    expect(mockResolveAccess).toHaveBeenCalledTimes(25);
    const gatedIds = mockResolveAccess.mock.calls
      .slice(1)
      .map((call: unknown[]) => call[1] as string);
    expect(gatedIds).toHaveLength(24);
    expect(gatedIds).toEqual(ids.slice(-24));
  });

  it('the gate fan-out runs in chunks, capping in-flight gate calls', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID)); // anchor

    const ids = Array.from(
      { length: 12 },
      (_, i) => `a0000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`
    );
    mockListMeetingsForContexts.mockResolvedValue(
      ids.map((id) => candidate(id, 'case', CASE_CONTEXT_ID))
    );

    let maxInFlight = 0;
    let inFlight = 0;
    mockResolveAccess.mockImplementation(async (...args: unknown[]) => {
      const meetingId = args[1] as string;
      if (meetingId === OWN_MEETING_ID) {
        return accessFor(OWN_MEETING_ID);
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return accessFor(meetingId);
    });

    const result = await loadGuestRecapIndex(input());

    expect(mockResolveAccess).toHaveBeenCalledTimes(13); // anchor + 12 candidates
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(0);
    expect(result?.kind === 'index' ? result.rows : []).toHaveLength(12);
  });

  it('the ended, in-envelope ANCHOR is reused, never re-gated', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID)); // anchor

    const siblingId = 'a0000000-0000-4000-8000-000000000051';
    mockListMeetingsForContexts.mockResolvedValue([
      candidate(OWN_MEETING_ID, 'case', CASE_CONTEXT_ID),
      candidate(siblingId, 'case', CASE_CONTEXT_ID),
    ]);
    mockResolveAccess.mockResolvedValueOnce(accessFor(siblingId));

    const result = await loadGuestRecapIndex(input());

    // Anchor call + ONE gate call for the sibling — the anchor's own id is never re-gated.
    expect(mockResolveAccess).toHaveBeenCalledTimes(2);
    const gatedMeetingIds = mockResolveAccess.mock.calls.map(
      (call: unknown[]) => call[1] as string
    );
    expect(gatedMeetingIds.filter((id) => id === OWN_MEETING_ID)).toHaveLength(1);
    const rows = result?.kind === 'index' ? result.rows : [];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.meetingId).sort((a, b) => a.localeCompare(b))).toEqual(
      [OWN_MEETING_ID, siblingId].sort((a, b) => a.localeCompare(b))
    );
  });
});

describe('dedupedEndedMeetingIds', () => {
  it('keeps only ended meetings, deduped by id, in input order', () => {
    const ids = dedupedEndedMeetingIds([
      candidate('m1', 'case', CASE_CONTEXT_ID, { status: 'ended' }),
      candidate('m2', 'case', CASE_CONTEXT_ID, { status: 'scheduled' }),
      candidate('m1', 'package_session', CASE_CONTEXT_ID, { status: 'ended' }),
      candidate('m3', 'case', CASE_CONTEXT_ID, { status: 'ended' }),
    ] as unknown as Parameters<typeof dedupedEndedMeetingIds>[0]);

    expect(ids).toHaveLength(2);
    expect(ids).toEqual(['m1', 'm3']);
  });

  it('returns an empty array when no candidate is ended', () => {
    const ids = dedupedEndedMeetingIds([
      candidate('m1', 'case', CASE_CONTEXT_ID, { status: 'scheduled' }),
      candidate('m2', 'case', CASE_CONTEXT_ID, { status: 'cancelled' }),
    ] as unknown as Parameters<typeof dedupedEndedMeetingIds>[0]);

    expect(ids).toEqual([]);
  });

  it('returns an empty array for an empty candidate list', () => {
    expect(dedupedEndedMeetingIds([])).toEqual([]);
  });
});

describe('loadGuestRecapIndex — exact key sets', () => {
  it('exact key set on a row', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID));
    const id = 'a0000000-0000-4000-8000-000000000041';
    mockListMeetingsForContexts.mockResolvedValue([candidate(id, 'case', CASE_CONTEXT_ID)]);
    mockResolveAccess.mockResolvedValueOnce(accessFor(id));

    const result = await loadGuestRecapIndex(input());
    const rows = result?.kind === 'index' ? result.rows : [];

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'contextLabel',
      'durationMinutes',
      'meetingId',
      'occurredAtIso',
    ]);
  });

  it('exact key set on the index result', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValue(accessFor(OWN_MEETING_ID));
    mockListMeetingsForContexts.mockResolvedValue([]);

    const result = await loadGuestRecapIndex(input());

    expect(Object.keys(result ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'guestId',
      'kind',
      'rows',
    ]);
  });
});

describe('loadGuestRecapIndex — failure handling', () => {
  it('a repository throw is caught, log.error`d with NO guestId, collapses to null', async () => {
    mockResolveSubject.mockResolvedValue(subjectFor());
    mockResolveAccess.mockResolvedValueOnce(accessFor(OWN_MEETING_ID));
    mockListMeetingsForContexts.mockRejectedValue(new Error('db unavailable'));

    const result = await loadGuestRecapIndex(input());

    expect(result).toBeNull();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to load guest recap index',
      expect.objectContaining({ error: 'db unavailable' })
    );
    const [, payload] = mockLog.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).not.toHaveProperty('guestId');
  });
});
