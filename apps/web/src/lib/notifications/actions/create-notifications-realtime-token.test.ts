import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-620 — unit tests for the notification bell's Ably token endpoint.
 *
 * ⚠ THE MINTED CAPABILITY IS THE POINT. The action takes no input, so the only channel a caller
 * can ever be granted is its own session's `notifications:{id}`, subscribe-only. The `['subscribe']`
 * JSON itself is pinned by `mint-subscribe-token.test.ts`; here the mint is mocked and its
 * ARGUMENTS are pinned instead.
 */

const USER_ID = 'u0000000-0000-4000-8000-00000000a002';
const TOKEN = { keyName: 'k', mac: 'm', nonce: 'n', timestamp: 1, capability: '{}' };

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockMint = vi.fn();
vi.mock('@/lib/realtime/mint-subscribe-token', () => ({
  mintSubscribeOnlyToken: (...a: unknown[]) => mockMint(...a),
}));

import { createNotificationsRealtimeTokenAction } from './create-notifications-realtime-token';
import { log } from '@/lib/logging';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockMint.mockResolvedValue({ success: true, tokenRequest: TOKEN });
});

describe('createNotificationsRealtimeTokenAction', () => {
  it('mints for exactly the session user and their own notifications channel', async () => {
    expect(await createNotificationsRealtimeTokenAction()).toEqual({
      success: true,
      tokenRequest: TOKEN,
    });

    expect(mockMint).toHaveBeenCalledTimes(1);
    // The channel is restated as a LITERAL: sharing the builder with production would let a
    // rename pass while disconnecting every live bell.
    expect(mockMint).toHaveBeenCalledWith({
      clientId: USER_ID,
      channels: [`notifications:${USER_ID}`],
    });
  });

  it('refuses an unauthenticated caller and never mints', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    expect(await createNotificationsRealtimeTokenAction()).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('returns the disabled flag and warns when ABLY_API_KEY is unset', async () => {
    mockMint.mockResolvedValue({ success: false, disabled: true });

    expect(await createNotificationsRealtimeTokenAction()).toEqual({
      success: false,
      disabled: true,
    });
    expect(log.warn).toHaveBeenCalledWith('Realtime disabled (no ABLY_API_KEY)', {
      userId: USER_ID,
    });
  });

  it('keeps the disabled answer distinct from the not-signed-in answer', async () => {
    mockMint.mockResolvedValue({ success: false, disabled: true });
    const disabled = await createNotificationsRealtimeTokenAction();

    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const unauthenticated = await createNotificationsRealtimeTokenAction();

    expect(disabled).not.toEqual(unauthenticated);
  });

  it('maps a mint failure to friendly copy and logs the cause', async () => {
    mockMint.mockRejectedValue(new Error('ably 500'));

    expect(await createNotificationsRealtimeTokenAction()).toEqual({
      success: false,
      error: 'Could not connect live updates.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to create notifications realtime token',
      expect.objectContaining({ userId: USER_ID, error: 'ably 500' })
    );
  });
});
