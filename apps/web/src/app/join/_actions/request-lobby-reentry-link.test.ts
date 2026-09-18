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
  LOBBY_REENTRY_RETRY_LATER_ERROR,
  LOBBY_REENTRY_TRANSPORT_ERROR,
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

/**
 * BAL-442 fix round (R-2) — THE COPY FOR A SERVER REFUSAL, AND WHY IT IS NO LONGER
 * `JOIN_UNAVAILABLE_TITLE`.
 *
 * That literal is deliberately collapsed to protect THE ANONYMITY OF A MEETING — and the api
 * route answers `202` with the neutral sentence for every meeting-related outcome there is
 * (its own docblock: "THERE IS NO `404` AND NO `409` ON THIS ROUTE, EVER"). So nothing that
 * reaches the failure arm is about a meeting, and "This link isn't active" was simply FALSE
 * there: it sent the guest off to chase a fresh link from whoever shared the meeting when the
 * honest answer was "wait a minute and try again".
 *
 * ⚠⚠ THE `429` IS STILL NOT SPLIT OUT. It is byte-identical to the `503` and the `400`, so no
 * wording tells an anonymous scanner they are being counted.
 */
describe('⚠⚠ requestLobbyReentryLinkAction — server refusals are honest, and indistinguishable from each other', () => {
  it.each([
    ['invalid_request', 400],
    ['rate_limited', 429],
    ['rate_limit_unavailable', 503],
  ])('maps `%s` (status %d) to the retry-later copy', async (code, status) => {
    mockPostLobbyReentryRequest.mockResolvedValue({ ok: false, status, code });

    await expect(requestLobbyReentryLinkAction(VALID)).resolves.toEqual({
      success: false,
      kind: 'unavailable',
      error: LOBBY_REENTRY_RETRY_LATER_ERROR,
    });
  });

  /**
   * ⚠ `0` IS THE TRANSPORT SENTINEL, NOT A STATUS THE SERVER SENT — a DNS failure, a dropped
   * connection. It is a fact about the caller's own connection, and it gets the SAME literal
   * the client component's `.catch()` arm renders for the identical condition, so one failure
   * mode cannot describe itself two ways depending on which layer noticed it.
   */
  it('⚠ maps the TRANSPORT SENTINEL (status 0) to the transport copy, not the retry-later one', async () => {
    mockPostLobbyReentryRequest.mockResolvedValue({
      ok: false,
      status: 0,
      code: 'request_failed',
    });

    await expect(requestLobbyReentryLinkAction(VALID)).resolves.toEqual({
      success: false,
      kind: 'unavailable',
      error: LOBBY_REENTRY_TRANSPORT_ERROR,
    });
  });

  /**
   * ⚠⚠ TEST #59, REWRITTEN FOR R-2 — the FOUR server-sent statuses still collapse to ONE error
   * string (so the rate-limit window is not disclosed), paired with a non-vacuous length
   * assertion so this cannot pass on an accidentally-empty list.
   */
  it('⚠ collapses ALL FOUR server-sent statuses into exactly one error string — 429 is NOT split out', async () => {
    const statuses: ReadonlyArray<{ code: string; status: number }> = [
      { code: 'invalid_request', status: 400 },
      { code: 'meeting_not_found', status: 404 },
      { code: 'rate_limited', status: 429 },
      { code: 'rate_limit_unavailable', status: 503 },
    ];

    const results = await Promise.all(
      statuses.map(async ({ code, status }) => {
        mockPostLobbyReentryRequest.mockResolvedValue({ ok: false, status, code });
        return requestLobbyReentryLinkAction(VALID);
      })
    );

    expect(results).toHaveLength(4);
    const errors = new Set(results.map((r) => (r.success ? null : r.error)));
    expect(errors.size).toBe(1);
    expect([...errors][0]).toBe(LOBBY_REENTRY_RETRY_LATER_ERROR);
  });

  /**
   * ⚠⚠ THE REGRESSION GUARD. `JOIN_UNAVAILABLE_TITLE` is still imported and still rendered by
   * `LobbyUnavailable` and `LinkNotActive` — it must simply never come back HERE, where it
   * would be a false statement about a meeting nothing on this path has an opinion about.
   */
  it('⚠⚠ NO status renders `JOIN_UNAVAILABLE_TITLE` any more', async () => {
    const statuses = [400, 404, 429, 503, 0];

    const results = await Promise.all(
      statuses.map(async (status) => {
        mockPostLobbyReentryRequest.mockResolvedValue({ ok: false, status, code: 'x' });
        return requestLobbyReentryLinkAction(VALID);
      })
    );

    expect(results).toHaveLength(5);
    expect(results.map((r) => (r.success ? null : r.error))).not.toContain(JOIN_UNAVAILABLE_TITLE);
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
