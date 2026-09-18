import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPostGuestJoinProbe } = vi.hoisted(() => ({ mockPostGuestJoinProbe: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/meetings/join-api-client', () => ({
  postGuestJoinProbe: mockPostGuestJoinProbe,
}));

import { log } from '@/lib/logging';
import { containsEmailAddress } from '@/test/contains-email-address';
import { resolveGuestExitReasonAction } from './resolve-guest-exit-reason';

/**
 * BAL-476 (R5 amended) — "why am I out of this call?", asked of the server.
 *
 * ⚠⚠ THE THREE PROPERTIES THIS FILE HOLDS:
 *   1. It maps through `guestExitCauseForStatus` and nowhere else.
 *   2. **IT NEVER THROWS** — a rejection here would land the ejected person in a Next error
 *      boundary instead of a card.
 *   3. No token, no email and no name reaches a log line.
 */

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const RAW_TOKEN = 'z'.repeat(43);

function ask() {
  return resolveGuestExitReasonAction({ meetingId: MEETING_ID, guestToken: RAW_TOKEN });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveGuestExitReasonAction', () => {
  it('⚠ asks with probe semantics — the id and the token, nothing else', async () => {
    mockPostGuestJoinProbe.mockResolvedValue({ ok: true, data: { state: 'live' } });

    await ask();

    expect(mockPostGuestJoinProbe).toHaveBeenCalledTimes(1);
    const [meetingId, token, signal] = mockPostGuestJoinProbe.mock.calls[0] as [
      string,
      string,
      AbortSignal,
    ];
    expect(meetingId).toBe(MEETING_ID);
    expect(token).toBe(RAW_TOKEN);
    // ⚠ ONE ATTEMPT, HARD-BOUNDED — the card offers no retry, so an unbounded probe would be a
    // spinner the person can never leave.
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('⚠ 404 ⇒ "removed"', async () => {
    mockPostGuestJoinProbe.mockResolvedValue({ ok: false, status: 404, code: 'meeting_not_found' });
    await expect(ask()).resolves.toBe('removed');
  });

  it('⚠ 409 ⇒ "host_ended"', async () => {
    mockPostGuestJoinProbe.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'meeting_not_open_for_join',
    });
    await expect(ask()).resolves.toBe('host_ended');
  });

  it.each([0, 429, 500, 503])('⚠ %i ⇒ "access_ended" — the vaguer card', async (status) => {
    mockPostGuestJoinProbe.mockResolvedValue({ ok: false, status, code: 'request_failed' });
    await expect(ask()).resolves.toBe('access_ended');
  });

  /**
   * ⚠ A LIVE MEETING AND A LIVE TOKEN, on a transition that says otherwise, is genuinely
   * inconclusive — most likely the ejection has not reached Postgres yet.
   */
  it('⚠ a 2xx ⇒ "access_ended", never a specific claim', async () => {
    mockPostGuestJoinProbe.mockResolvedValue({ ok: true, data: { state: 'live' } });
    await expect(ask()).resolves.toBe('access_ended');
  });

  it('⚠ NEVER THROWS on a transport rejection — it resolves to the vaguer card', async () => {
    mockPostGuestJoinProbe.mockRejectedValue(new Error('aborted'));
    await expect(ask()).resolves.toBe('access_ended');
  });

  it('a malformed input resolves to "access_ended" without asking at all', async () => {
    await expect(
      resolveGuestExitReasonAction({ meetingId: 'not-a-uuid', guestToken: RAW_TOKEN })
    ).resolves.toBe('access_ended');
    await expect(
      resolveGuestExitReasonAction({ meetingId: MEETING_ID, guestToken: 'short' })
    ).resolves.toBe('access_ended');
    expect(mockPostGuestJoinProbe).not.toHaveBeenCalled();
  });

  it('⚠ logs the meeting id and the status ONLY — no token, no email, no name', async () => {
    mockPostGuestJoinProbe.mockResolvedValue({ ok: false, status: 404, code: 'meeting_not_found' });

    await ask();

    const warnCalls = vi.mocked(log.warn).mock.calls;
    expect(warnCalls).toHaveLength(1);
    const fields = warnCalls[0]?.[1] as Record<string, unknown>;
    expect(fields).toEqual({ meetingId: MEETING_ID, status: 404 });
    const serialized = JSON.stringify(warnCalls);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(serialized).not.toContain(RAW_TOKEN.slice(0, 8));
    expect(containsEmailAddress(serialized)).toBe(false);
  });

  it('⚠ logs no token on the rejection path either', async () => {
    mockPostGuestJoinProbe.mockRejectedValue(new Error('aborted'));

    await ask();

    const serialized = JSON.stringify(vi.mocked(log.warn).mock.calls);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(serialized).toContain(MEETING_ID);
  });
});
