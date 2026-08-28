import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const GUEST_ID = 'e0000000-0000-4000-8000-00000000000e';
const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const IP_HASH = 'f'.repeat(64);
const TRANSCRIPT_ID = 'b0000000-0000-4000-8000-00000000000b';

const { mockFindByMeetingId, mockFindByTranscriptAndKind } = vi.hoisted(() => ({
  mockFindByMeetingId: vi.fn(),
  mockFindByTranscriptAndKind: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  transcriptsRepository: { findByMeetingId: (...a: unknown[]) => mockFindByMeetingId(...a) },
  transcriptArtifactsRepository: {
    findByTranscriptAndKind: (...a: unknown[]) => mockFindByTranscriptAndKind(...a),
  },
}));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/meetings/resolve-guest-recap-access', () => ({
  resolveGuestRecapAccess: (...a: unknown[]) => mockResolveAccess(...a),
}));

import { loadGuestRecap } from './load-guest-recap';

function guestAccess(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    guestId: GUEST_ID,
    accessScope: 'meeting',
    meeting: {
      id: MEETING_ID,
      status: 'ended',
      startedAt: null,
      endedAt: null,
      scheduledStart: new Date('2026-08-01T10:00:00.000Z'),
      scheduledEnd: new Date('2026-08-01T11:00:00.000Z'),
    },
    subject: { contextType: 'case', contextId: 'c0000000-0000-4000-8000-000000000003' },
    isOwnMeeting: true,
    ...overrides,
  };
}

function loaderInput(): { rawToken: string; meetingId: string; clientIpHash: string } {
  return { rawToken: RAW_TOKEN, meetingId: MEETING_ID, clientIpHash: IP_HASH };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckLimit.mockReturnValue(true);
});

describe('loadGuestRecap — throttling', () => {
  it('throttled on the IP key ⇒ null, and the gate is never called', async () => {
    mockCheckLimit.mockReturnValue(false);

    const result = await loadGuestRecap(loaderInput());

    expect(result).toBeNull();
    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('throttled on the :gid: key ⇒ null, and no repository is read', async () => {
    mockCheckLimit.mockImplementation((key: string) => !key.includes(':gid:'));
    mockResolveAccess.mockResolvedValue(guestAccess());

    const result = await loadGuestRecap(loaderInput());

    expect(result).toBeNull();
    expect(mockFindByMeetingId).not.toHaveBeenCalled();
  });

  it('⚠⚠ S1 — the two limiter keys use DISJOINT :ip:/:gid: prefixes', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);

    await loadGuestRecap(loaderInput());

    const keys = mockCheckLimit.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(keys).toHaveLength(2);
    const [ipKey, gidKey] = keys;
    expect(ipKey).toContain(':ip:');
    expect(ipKey).not.toContain(':gid:');
    expect(gidKey).toContain(':gid:');
    expect(gidKey).not.toContain(':ip:');
  });
});

describe('loadGuestRecap — lifecycle (the loader`s own gate)', () => {
  it.each(['scheduled', 'waiting_for_participants', 'in_progress', 'cancelled'])(
    'meeting.status=%s ⇒ null, WITH the gate having returned ok (proves the lifecycle guard is the loader`s)',
    async (status) => {
      const access = guestAccess();
      const meeting = access.meeting as Record<string, unknown>;
      mockResolveAccess.mockResolvedValue({ ...access, meeting: { ...meeting, status } });

      const result = await loadGuestRecap(loaderInput());

      expect(result).toBeNull();
      expect(mockResolveAccess).toHaveBeenCalledTimes(1);
      expect(mockFindByMeetingId).not.toHaveBeenCalled();
    }
  );

  it('meeting.status="ended" proceeds past the lifecycle guard', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);

    const result = await loadGuestRecap(loaderInput());

    expect(result).not.toBeNull();
  });
});

describe('loadGuestRecap — the structural concealment proof', () => {
  it('⚠⚠ exact key set on the view — no recordings, money, party, actionItems, transcript, files, guestId, accessScope', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);

    const result = await loadGuestRecap(loaderInput());

    expect(result).not.toBeNull();
    expect(Object.keys(result?.view ?? {}).sort()).toEqual([
      'header',
      'isOwnMeeting',
      'meetingId',
      'summary',
    ]);
  });

  it('⚠ exact key set on the header — no Meeting row field (dailyRoomName, joinUrl) crosses', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);

    const result = await loadGuestRecap(loaderInput());

    expect(Object.keys(result?.view.header ?? {}).sort()).toEqual([
      'contextLabel',
      'durationMinutes',
      'occurredAtIso',
    ]);
  });

  /**
   * ⚠⚠ fix-round-1 / S1 — `GuestRecapView` (above) is pinned; the WRAPPER around it was not,
   * so a future edit could add `meeting` or `subject` to {@link GuestRecapLoadResult} with
   * nothing firing.
   */
  it('⚠⚠ S1 — exact key set on the WRAPPER result — guestId/accessScope never widen', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);

    const result = await loadGuestRecap(loaderInput());

    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual(['accessScope', 'guestId', 'view']);
  });

  /**
   * ⚠⚠ fix-round-1 / MUST-5 (security F4) — `view.meetingId` is THE GATE'S ROW
   * (`access.meeting.id`), NEVER the parsed input. Proven by making them disagree: an
   * upper-cased input must not survive into the view unchanged.
   */
  it('⚠⚠ MUST-5 — view.meetingId is access.meeting.id, not the caller`s input', async () => {
    // `guestAccess()`'s default `meeting.id` IS `MEETING_ID` (the gate's canonical row); the
    // caller's own input is deliberately a DIFFERENT casing of the same id, so the two can
    // only agree in the output if the code reads `access.meeting.id`.
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);
    const upperCasedInput = MEETING_ID.toUpperCase();

    const result = await loadGuestRecap({ ...loaderInput(), meetingId: upperCasedInput });

    expect(result?.view.meetingId).toBe(MEETING_ID);
    expect(result?.view.meetingId).not.toBe(upperCasedInput);
  });
});

describe('loadGuestRecap — artefact reads', () => {
  it('reads `findByTranscriptAndKind` exactly ONCE, with `summary`, and NEVER with `cleaned`', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue({ id: TRANSCRIPT_ID, status: 'ready' });
    mockFindByTranscriptAndKind.mockResolvedValue({ content: 'A great call.' });

    await loadGuestRecap(loaderInput());

    expect(mockFindByTranscriptAndKind).toHaveBeenCalledTimes(1);
    expect(mockFindByTranscriptAndKind).toHaveBeenCalledWith(TRANSCRIPT_ID, 'summary');
    const kinds = mockFindByTranscriptAndKind.mock.calls.map((call: unknown[]) => call[1]);
    expect(kinds).not.toContain('cleaned');
  });

  it('no transcript row ⇒ the artefact repository is NEVER called at all, state absent', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);

    const result = await loadGuestRecap(loaderInput());

    expect(mockFindByTranscriptAndKind).not.toHaveBeenCalled();
    expect(result?.view.summary).toEqual({ state: 'absent', content: null });
  });
});

describe('loadGuestRecap — summary states', () => {
  it('transcript status "failed" ⇒ summary state "failed"', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue({ id: TRANSCRIPT_ID, status: 'failed' });

    const result = await loadGuestRecap(loaderInput());

    expect(result?.view.summary).toEqual({ state: 'failed', content: null });
    // ⚠⚠ fix-round-1 / S2+S3 — the artefact table is NOW genuinely never read once the status
    // already resolves the state (S3's guard). This used to assert the OPPOSITE
    // (`toHaveBeenCalled()`) directly beneath a comment claiming the read never happened —
    // the comment and the assertion contradicted each other. S3 makes the comment true.
    expect(mockFindByTranscriptAndKind).not.toHaveBeenCalled();
  });

  it('transcript status "processing" ⇒ summary state "processing", and the artefact table is never read', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue({ id: TRANSCRIPT_ID, status: 'processing' });

    const result = await loadGuestRecap(loaderInput());

    expect(result?.view.summary).toEqual({ state: 'processing', content: null });
    // ⚠⚠ fix-round-1 / S3 — same guard as the "failed" case above.
    expect(mockFindByTranscriptAndKind).not.toHaveBeenCalled();
  });

  it('⚠ a whitespace-only artefact NORMALISES to "absent" — never a `ready` card with no body', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue({ id: TRANSCRIPT_ID, status: 'ready' });
    mockFindByTranscriptAndKind.mockResolvedValue({ content: '   ' });

    const result = await loadGuestRecap(loaderInput());

    expect(result?.view.summary).toEqual({ state: 'absent', content: null });
  });

  it('real text ⇒ "ready" with TRIMMED content', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue({ id: TRANSCRIPT_ID, status: 'ready' });
    mockFindByTranscriptAndKind.mockResolvedValue({ content: '  A great call.  ' });

    const result = await loadGuestRecap(loaderInput());

    expect(result?.view.summary).toEqual({ state: 'ready', content: 'A great call.' });
  });
});

describe('loadGuestRecap — duration', () => {
  it('durationMinutes is null when either stamp is missing (the common case today)', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockResolvedValue(undefined);

    const result = await loadGuestRecap(loaderInput());

    expect(result?.view.header.durationMinutes).toBeNull();
  });

  it('resolves whole minutes when both stamps are present', async () => {
    const access = guestAccess();
    const meeting = access.meeting as Record<string, unknown>;
    mockResolveAccess.mockResolvedValue({
      ...access,
      meeting: {
        ...meeting,
        startedAt: new Date('2026-08-01T10:00:00.000Z'),
        endedAt: new Date('2026-08-01T10:32:00.000Z'),
      },
    });
    mockFindByMeetingId.mockResolvedValue(undefined);

    const result = await loadGuestRecap(loaderInput());

    expect(result?.view.header.durationMinutes).toBe(32);
  });
});

describe('loadGuestRecap — failure handling and logging', () => {
  it('a repository throw is caught, log.error`d with NO guestId, and collapses to null', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess());
    mockFindByMeetingId.mockRejectedValue(new Error('db unavailable'));

    const result = await loadGuestRecap(loaderInput());

    expect(result).toBeNull();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to load guest recap',
      expect.objectContaining({ meetingId: MEETING_ID })
    );
    const [, payload] = mockLog.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).not.toHaveProperty('guestId');
  });

  it('success logs `log.info` with guestId, accessScope and isOwnMeeting (not an exact key set)', async () => {
    mockResolveAccess.mockResolvedValue(guestAccess({ accessScope: 'engagement' }));
    mockFindByMeetingId.mockResolvedValue(undefined);

    await loadGuestRecap(loaderInput());

    expect(mockLog.info).toHaveBeenCalledWith(
      'Guest recap opened',
      expect.objectContaining({
        guestId: GUEST_ID,
        accessScope: 'engagement',
        isOwnMeeting: true,
      })
    );
  });
});
