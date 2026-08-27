import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const GUEST_ID = 'b0000000-0000-4000-8000-000000000002';
const FILE_ID = 'c0000000-0000-4000-8000-000000000003';
const CREATED_AT = new Date('2026-08-11T10:00:00Z');
const GUEST_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';

vi.mock('server-only', () => ({}));

const mockListByMeeting = vi.fn();
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { listByMeeting: (...args: unknown[]) => mockListByMeeting(...args) },
  MEETING_FILE_LIST_LIMIT: 200,
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
}));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

const mockResolveSubject = vi.fn();
vi.mock('@/lib/meetings/resolve-meeting-guest', () => ({
  resolveMeetingGuestSubject: (...a: unknown[]) => mockResolveSubject(...a),
}));

const mockAuthorize = vi.fn();
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

import { listGuestMeetingFilesAction } from './list-guest-meeting-files';
import { log } from '@/lib/logging';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FILE_ID,
    meetingId: MEETING_ID,
    uploadedByUserId: 'some-user',
    party: 'client',
    source: 'chat',
    r2Key: `meeting-files/${MEETING_ID}/leaf`,
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1234,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
    ...overrides,
  };
}

const VALID_INPUT = { meetingId: MEETING_ID, guestToken: GUEST_TOKEN };
const SUBJECT = { guest: { id: GUEST_ID, accessScope: 'meeting' }, meeting: { id: MEETING_ID } };

describe('listGuestMeetingFilesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.mockResolvedValue(new Headers());
    mockCheckLimit.mockReturnValue(true);
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: GUEST_ID,
      accessScope: 'meeting',
      // ⚠ F8/Uniformity (fix-round-1) — the real gate ALWAYS returns `meeting`; this action now
      // reads `access.meeting.id`, never the parsed input, matching the sibling download action.
      meeting: { id: MEETING_ID },
    });
    mockListByMeeting.mockResolvedValue([]);
  });

  it('refuses when throttled, before resolving the token', async () => {
    mockCheckLimit.mockReturnValue(false);
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockResolveSubject).not.toHaveBeenCalled();
  });

  it('refuses a malformed input before resolving the token', async () => {
    const result = await listGuestMeetingFilesAction({ meetingId: 'nope' } as never);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockResolveSubject).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable token with the SAME collapsed literal', async () => {
    mockResolveSubject.mockResolvedValue(null);
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('passes a GUEST actor to the shipped gate — never a member one', async () => {
    await listGuestMeetingFilesAction(VALID_INPUT);
    expect(mockAuthorize).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: SUBJECT },
    });
  });

  /**
   * ⚠⚠ F7 (fix-round-1) — a SECOND rate limit, keyed on the RESOLVED `guest.id`, runs after
   * `resolveMeetingGuestSubject` and before the gate. The IP-keyed limiter above trusts a
   * spoofable header; this one is stable, non-spoofable and revocable.
   */
  it('refuses on the SECOND (guest-id-keyed) limit, even when the IP-keyed one allows it', async () => {
    mockCheckLimit.mockImplementation((key: string) => !key.includes(':gid:'));
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('keys the second limiter on the RESOLVED guest id, distinctly from the IP key', async () => {
    await listGuestMeetingFilesAction(VALID_INPUT);
    const keys = mockCheckLimit.mock.calls.map((call) => call[0] as string);
    expect(keys.some((key) => key.includes(GUEST_ID))).toBe(true);
    expect(keys).toHaveLength(2);
  });

  /**
   * ⚠⚠ S1 (fix-round-2) regression — round 1's IP key (`guest-files:${clientIp}`) was a bare
   * prefix of its guest-id key (`guest-files:id:${guestId}`), so
   * `X-Forwarded-For: id:<victimGuestId>` produced the byte-identical victim key. The fix keys
   * on disjoint `:ip:` / `:gid:` prefixes and hashes the IP segment so it can never contain `:`.
   * This asserts both properties hold even under a hostile header carrying the OLD collision
   * shape.
   */
  it('S1 — a hostile X-Forwarded-For cannot forge the guest-id-keyed bucket', async () => {
    mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': `id:${GUEST_ID}` }));
    await listGuestMeetingFilesAction(VALID_INPUT);
    const keys = mockCheckLimit.mock.calls.map((call) => call[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).not.toContain(GUEST_ID);
    expect(keys.some((key) => key === `guest-files:gid:${GUEST_ID}`)).toBe(true);
  });

  it('refuses a gate denial (out-of-scope meeting) with the same literal', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(mockListByMeeting).not.toHaveBeenCalled();
  });

  it('lists both sources, unfiltered, same as the member action', async () => {
    mockListByMeeting.mockResolvedValue([
      row({ id: 'f1', source: 'chat' }),
      row({ id: 'f2', source: 'files_tab' }),
    ]);
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toMatchObject({ success: true, files: [{ id: 'f1' }, { id: 'f2' }] });
  });

  it('never projects r2Key', async () => {
    mockListByMeeting.mockResolvedValue([row()]);
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result.success ? result.files[0] : {}).not.toHaveProperty('r2Key');
  });

  it('drops a corrupt (non-two-sided) party row and logs it', async () => {
    mockListByMeeting.mockResolvedValue([row({ party: 'observer' })]);
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: true, files: [] });
    expect(log.warn).toHaveBeenCalledWith(
      'Dropping meeting file with a non-two-sided party (guest read)',
      expect.objectContaining({ guestId: GUEST_ID })
    );
  });

  it('warns, without truncating the returned list itself, at the bound', async () => {
    mockListByMeeting.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => row({ id: `f${i}` }))
    );
    await listGuestMeetingFilesAction(VALID_INPUT);
    expect(log.warn).toHaveBeenCalledWith(
      'Guest meeting file list hit its bound — newest files were truncated',
      expect.objectContaining({ meetingId: MEETING_ID, guestId: GUEST_ID, limit: 200 })
    );
  });

  it('maps a repository throw to the collapsed literal and logs the shape', async () => {
    mockListByMeeting.mockRejectedValue(new Error('db down'));
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(log.error).toHaveBeenCalled();
  });

  /**
   * ⚠⚠ F8/WARNING-1 (fix-round-1) — `resolveMeetingGuestSubject` now runs INSIDE the `try`, so
   * a throw FROM THE RESOLVER ITSELF (not merely a downstream repository read) is logged and
   * collapsed too, rather than escaping the action and rejecting the client promise.
   */
  it('maps a throw FROM resolveMeetingGuestSubject itself to the collapsed literal', async () => {
    mockResolveSubject.mockRejectedValue(new Error('resolver blew up'));
    const result = await listGuestMeetingFilesAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
    expect(log.error).toHaveBeenCalled();
  });
});
