import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPostLobbyReentryRequest = vi.fn();
vi.mock('@/lib/meetings/join-api-client', () => ({
  postLobbyReentryRequest: (...args: unknown[]) => mockPostLobbyReentryRequest(...args),
}));

import { requestLobbyReentryLinkAction } from './request-lobby-reentry-link';
import { log } from '@/lib/logging';
import {
  JOIN_UNAVAILABLE_TITLE,
  LOBBY_REENTRY_INVALID_INPUT_ERROR,
  LOBBY_REENTRY_NEUTRAL_MESSAGE,
} from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const VALID = { meetingId: MEETING_ID, email: 'sam@cloudpeak.example' };

beforeEach(() => {
  vi.clearAllMocks();
  mockPostLobbyReentryRequest.mockResolvedValue({ ok: true, data: { state: 'requested' } });
});

describe('requestLobbyReentryLinkAction — the happy path', () => {
  it('returns the NEUTRAL, imported constant — never a hand-copied literal', async () => {
    await expect(requestLobbyReentryLinkAction(VALID)).resolves.toEqual({
      success: true,
      message: LOBBY_REENTRY_NEUTRAL_MESSAGE,
    });
    expect(mockPostLobbyReentryRequest).toHaveBeenCalledWith(MEETING_ID, 'sam@cloudpeak.example');
  });

  it('trims and forwards the submitted email', async () => {
    await requestLobbyReentryLinkAction({ ...VALID, email: '  SAM@x.example ' });

    expect(mockPostLobbyReentryRequest).toHaveBeenCalledWith(MEETING_ID, 'SAM@x.example');
  });

  it('logs success without the address — the meeting id is present, the address is not', async () => {
    await requestLobbyReentryLinkAction(VALID);

    expect(log.info).toHaveBeenCalledWith(
      'Lobby re-entry requested',
      expect.objectContaining({ meetingId: MEETING_ID })
    );
    expect(JSON.stringify((log.info as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'sam@cloudpeak.example'
    );
  });
});

describe('requestLobbyReentryLinkAction — validation', () => {
  it.each([
    ['a non-uuid meeting id', { ...VALID, meetingId: 'not-a-uuid' }],
    ['a missing email', { meetingId: MEETING_ID }],
    ['a malformed email', { ...VALID, email: 'nope' }],
  ])('refuses %s WITHOUT calling the api', async (_label, input) => {
    const result = await requestLobbyReentryLinkAction(
      input as { meetingId: string; email: string }
    );

    expect(result.success).toBe(false);
    expect(mockPostLobbyReentryRequest).not.toHaveBeenCalled();
  });

  it('⚠ invalid email → { success:false, kind:"invalid_input" } and the api is NOT called', async () => {
    const result = await requestLobbyReentryLinkAction({ ...VALID, email: 'nope' });

    expect(result).toEqual({
      success: false,
      kind: 'invalid_input',
      error: LOBBY_REENTRY_INVALID_INPUT_ERROR,
    });
    expect(mockPostLobbyReentryRequest).not.toHaveBeenCalled();
  });
});

describe('⚠⚠ requestLobbyReentryLinkAction — every non-2xx status returns the SAME string', () => {
  it.each([
    ['invalid_request', 400],
    ['rate_limited', 429],
    ['rate_limit_unavailable', 503],
    ['request_failed', 0],
  ])('maps `%s` (status %d) to the uniform copy', async (code, status) => {
    mockPostLobbyReentryRequest.mockResolvedValue({ ok: false, status, code });

    await expect(requestLobbyReentryLinkAction(VALID)).resolves.toEqual({
      success: false,
      kind: 'unavailable',
      error: JOIN_UNAVAILABLE_TITLE,
    });
  });

  /**
   * ⚠⚠ TEST #59 — every non-2xx status collapses to ONE error string, paired with a
   * non-vacuous length assertion so this cannot pass on an accidentally-empty list.
   */
  it('⚠ collapses ALL FIVE statuses into exactly one error string — 429 is NOT split out', async () => {
    const statuses: ReadonlyArray<{ code: string; status: number }> = [
      { code: 'invalid_request', status: 400 },
      { code: 'meeting_not_found', status: 404 },
      { code: 'rate_limited', status: 429 },
      { code: 'rate_limit_unavailable', status: 503 },
      { code: 'request_failed', status: 0 },
    ];

    const results = await Promise.all(
      statuses.map(async ({ code, status }) => {
        mockPostLobbyReentryRequest.mockResolvedValue({ ok: false, status, code });
        return requestLobbyReentryLinkAction(VALID);
      })
    );

    expect(results).toHaveLength(5);
    const errors = new Set(results.map((r) => (r.success ? null : r.error)));
    expect(errors.size).toBe(1);
    expect([...errors][0]).toBe(JOIN_UNAVAILABLE_TITLE);
  });

  it('⚠ no log call contains the address; meetingId IS present (non-vacuity pair)', async () => {
    mockPostLobbyReentryRequest.mockResolvedValue({
      ok: false,
      status: 429,
      code: 'rate_limited',
    });

    await requestLobbyReentryLinkAction(VALID);

    expect(log.warn).toHaveBeenCalledWith(
      'Lobby re-entry refused',
      expect.objectContaining({ meetingId: MEETING_ID, status: 429, code: 'rate_limited' })
    );
    const serialised = JSON.stringify((log.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(serialised).not.toContain('sam@cloudpeak.example');
  });

  it('never echoes the api error code to the caller', async () => {
    mockPostLobbyReentryRequest.mockResolvedValue({
      ok: false,
      status: 429,
      code: 'rate_limited',
    });

    const result = await requestLobbyReentryLinkAction(VALID);

    expect(JSON.stringify(result)).not.toContain('rate_limited');
    expect(JSON.stringify(result)).not.toContain(MEETING_ID);
  });
});
