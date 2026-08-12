import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPostLobbyClaim = vi.fn();
vi.mock('@/lib/meetings/join-api-client', () => ({
  postLobbyClaim: (...args: unknown[]) => mockPostLobbyClaim(...args),
}));

import { claimLobbyPlaceAction } from './claim-lobby-place';
import { JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const LOBBY_TOKEN = 'z'.repeat(43);

const VALID = { meetingId: MEETING_ID, name: 'Sam Rivera', email: 'sam@cloudpeak.example' };

beforeEach(() => {
  vi.clearAllMocks();
  mockPostLobbyClaim.mockResolvedValue({
    ok: true,
    data: { state: 'waiting', lobbyToken: LOBBY_TOKEN },
  });
});

describe('claimLobbyPlaceAction — the happy path', () => {
  it('returns the lobby token to its bearer', async () => {
    await expect(claimLobbyPlaceAction(VALID)).resolves.toEqual({
      success: true,
      lobbyToken: LOBBY_TOKEN,
    });
    expect(mockPostLobbyClaim).toHaveBeenCalledWith(
      MEETING_ID,
      'Sam Rivera',
      'sam@cloudpeak.example'
    );
  });

  it('trims the submitted fields before forwarding', async () => {
    await claimLobbyPlaceAction({ ...VALID, name: '  Sam Rivera  ', email: '  SAM@x.example ' });

    expect(mockPostLobbyClaim).toHaveBeenCalledWith(MEETING_ID, 'Sam Rivera', 'SAM@x.example');
  });
});

describe('claimLobbyPlaceAction — validation', () => {
  it.each([
    ['a non-uuid meeting id', { ...VALID, meetingId: 'not-a-uuid' }],
    ['an empty name', { ...VALID, name: '   ' }],
    ['a malformed email', { ...VALID, email: 'nope' }],
    ['an over-long name', { ...VALID, name: 'x'.repeat(161) }],
  ])('refuses %s WITHOUT calling the api', async (_label, input) => {
    const result = await claimLobbyPlaceAction(input);

    expect(result.success).toBe(false);
    expect(mockPostLobbyClaim).not.toHaveBeenCalled();
  });

  it('⚠ a malformed FORM gets a distinct message — it is a fact about the caller`s own input', async () => {
    // The ONE thing this action may say more about, because it reveals nothing about any
    // meeting.
    const result = await claimLobbyPlaceAction({ ...VALID, email: 'nope' });

    expect(result).toEqual({
      success: false,
      kind: 'invalid_input',
      error: 'Please enter your name and a valid email address.',
    });
  });

  it('⚠⚠ marks a validation failure `invalid_input`, NOT `unavailable` — the UI must not go terminal', async () => {
    // Reachable in ordinary use: the browser's own `required` accepts a whitespace-only name
    // and `type="email"` accepts `a@b`, and Zod rejects both. Without the discriminant the UI
    // threw away what the visitor typed and stranded them on a dead-link card.
    const whitespaceName = await claimLobbyPlaceAction({ ...VALID, name: '   ' });
    const browserAcceptedEmail = await claimLobbyPlaceAction({ ...VALID, email: 'a@b' });

    expect(whitespaceName).toMatchObject({ success: false, kind: 'invalid_input' });
    expect(browserAcceptedEmail).toMatchObject({ success: false, kind: 'invalid_input' });
  });
});

describe('⚠⚠ claimLobbyPlaceAction — every API failure returns the SAME string', () => {
  it.each([
    ['meeting_not_found', 404],
    ['meeting_not_open_for_join', 409],
    ['rate_limited', 429],
    ['rate_limit_unavailable', 503],
    ['request_failed', 0],
  ])('maps `%s` to the uniform copy', async (code, status) => {
    mockPostLobbyClaim.mockResolvedValue({ ok: false, status, code });

    await expect(claimLobbyPlaceAction(VALID)).resolves.toEqual({
      success: false,
      kind: 'unavailable',
      error: JOIN_UNAVAILABLE_TITLE,
    });
  });

  it('⚠ produces ONE distinct result across every failure — no oracle', async () => {
    // The api already refuses to tell us which failure it was; this layer must not invent a
    // distinction it does not have.
    const rendered = new Set<string>();
    for (const code of ['meeting_not_found', 'rate_limited', 'request_failed']) {
      mockPostLobbyClaim.mockResolvedValue({ ok: false, status: 404, code });
      rendered.add(JSON.stringify(await claimLobbyPlaceAction(VALID)));
    }

    expect(rendered.size).toBe(1);
  });

  it('never echoes the api`s error code to the caller', async () => {
    mockPostLobbyClaim.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'meeting_not_open_for_join',
    });

    const result = await claimLobbyPlaceAction(VALID);

    expect(JSON.stringify(result)).not.toContain('meeting_not_open_for_join');
    expect(JSON.stringify(result)).not.toContain(MEETING_ID);
  });
});
