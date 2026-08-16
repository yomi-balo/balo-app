import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-437 — the ONE place a client-bound Ably token is minted.
 *
 * ⚠⚠ THE CAPABILITY MAP IS THE WHOLE POINT OF THIS FILE. `subscribe` and only `subscribe`, over
 * explicit channels and never a wildcard, is what makes a tampered client unable to spoof a
 * message into anybody's thread. Everything else here is scaffolding around that assertion.
 */

vi.mock('server-only', () => ({}));

const { mockIsRealtimeConfigured, mockGetAblyRest, mockCreateTokenRequest } = vi.hoisted(() => ({
  mockIsRealtimeConfigured: vi.fn(),
  mockGetAblyRest: vi.fn(),
  mockCreateTokenRequest: vi.fn(),
}));

vi.mock('./ably-server', () => ({
  isRealtimeConfigured: mockIsRealtimeConfigured,
  getAblyRest: mockGetAblyRest,
}));

import { mintSubscribeOnlyToken, TOKEN_TTL_MS } from './mint-subscribe-token';

const CLIENT_ID = 'u0000000-0000-4000-8000-000000000001';
const CHANNEL_A = 'meeting:0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const CHANNEL_B = 'conversation:3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** The single argument `createTokenRequest` was called with, parsed. */
function capabilityArg(): Record<string, string[]> {
  const [call] = mockCreateTokenRequest.mock.calls;
  const [params] = call ?? [];
  return JSON.parse((params as { capability: string }).capability) as Record<string, string[]>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsRealtimeConfigured.mockReturnValue(true);
  mockCreateTokenRequest.mockResolvedValue({ keyName: 'app.key', mac: 'sig' });
  mockGetAblyRest.mockReturnValue({ auth: { createTokenRequest: mockCreateTokenRequest } });
});

describe('mintSubscribeOnlyToken — ⚠⚠ the capability map', () => {
  it('grants `subscribe` and NOTHING ELSE, for every channel', async () => {
    await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A, CHANNEL_B] });

    const capability = capabilityArg();
    expect(Object.keys(capability)).toEqual([CHANNEL_A, CHANNEL_B]);
    for (const ops of Object.values(capability)) {
      expect(ops).toEqual(['subscribe']);
    }
  });

  it('⚠⚠ contains NO WILDCARD anywhere in the serialised capability', async () => {
    await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A] });

    const [call] = mockCreateTokenRequest.mock.calls;
    const [params] = call ?? [];
    expect((params as { capability: string }).capability).not.toContain('*');
  });

  it('never grants `publish` or `presence` — R2 and the shipped spoofing invariant', async () => {
    await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A] });

    const serialised = JSON.stringify(capabilityArg());
    expect(serialised).not.toContain('publish');
    expect(serialised).not.toContain('presence');
  });

  it('passes the clientId through, so Ably attributes the connection to a real user', async () => {
    await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A] });

    const [call] = mockCreateTokenRequest.mock.calls;
    expect(call?.[0]).toMatchObject({ clientId: CLIENT_ID });
  });

  it('uses the 15-minute TTL — the bound on a revoked member’s live subscription', async () => {
    expect(TOKEN_TTL_MS).toBe(15 * 60 * 1000);

    await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A] });

    const [call] = mockCreateTokenRequest.mock.calls;
    expect(call?.[0]).toMatchObject({ ttl: TOKEN_TTL_MS });
  });

  it('returns the token request on success', async () => {
    const result = await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A] });

    expect(result).toEqual({ success: true, tokenRequest: { keyName: 'app.key', mac: 'sig' } });
  });
});

describe('mintSubscribeOnlyToken — degradation and programming errors', () => {
  it('⚠ unconfigured ⇒ `{ disabled: true }` and NO token round trip', async () => {
    mockIsRealtimeConfigured.mockReturnValue(false);

    const result = await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A] });

    expect(result).toEqual({ success: false, disabled: true });
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('⚠ a null REST client is the same answer — defensive, unreachable after the gate', async () => {
    mockGetAblyRest.mockReturnValue(null);

    const result = await mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [CHANNEL_A] });

    expect(result).toEqual({ success: false, disabled: true });
  });

  it('⚠⚠ THROWS on an empty channel list — the caller owns emptiness and its own copy', async () => {
    await expect(mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: [] })).rejects.toThrow(
      /no channels/i
    );
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('⚠⚠ THROWS on a wildcard channel — failing loudly is the only safe direction', async () => {
    await expect(
      mintSubscribeOnlyToken({ clientId: CLIENT_ID, channels: ['conversation:*'] })
    ).rejects.toThrow(/wildcard/i);
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });
});
