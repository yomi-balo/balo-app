import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';

/**
 * The shared tail of the three typing Server Actions: impersonation → gate → publish.
 *
 * ⚠ `publishTypingSignal` is the only thing mocked — the impersonation predicate is the real one,
 * so "an impersonated session publishes nothing" is asserted against the platform's one
 * definition of impersonation, not a stub of it.
 */

vi.mock('server-only', () => ({}));

const { mockPublishTypingSignal } = vi.hoisted(() => ({ mockPublishTypingSignal: vi.fn() }));
vi.mock('./ably-server', () => ({ publishTypingSignal: mockPublishTypingSignal }));

import { log } from '@/lib/logging';
import { relayTypingSignal, TYPING_DENIED } from './relay-typing-signal';

const USER = { id: 'u0000000-0000-4000-8000-000000000001' } as SessionUser;
const GATE_CONVERSATION_ID = 'c0000000-0000-4000-8000-00000000c0de';

beforeEach(() => {
  vi.clearAllMocks();
  mockPublishTypingSignal.mockResolvedValue(undefined);
});

describe('relayTypingSignal', () => {
  it('⚠⚠ publishes on the GATE’s conversation, as the SESSION user', async () => {
    const result = await relayTypingSignal({
      user: USER,
      signal: 'started',
      logContext: {},
      resolvePostableConversationId: () => Promise.resolve(GATE_CONVERSATION_ID),
    });

    expect(result).toEqual({ success: true });
    expect(mockPublishTypingSignal).toHaveBeenCalledTimes(1);
    expect(mockPublishTypingSignal).toHaveBeenCalledWith(GATE_CONVERSATION_ID, USER.id, 'started');
  });

  it('a gate that answers null publishes NOTHING and returns the one denial literal', async () => {
    const result = await relayTypingSignal({
      user: USER,
      signal: 'stopped',
      logContext: {},
      resolvePostableConversationId: () => Promise.resolve(null),
    });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('⚠ an IMPERSONATED session is refused before the gate runs — nothing is published', async () => {
    const gate = vi.fn(() => Promise.resolve(GATE_CONVERSATION_ID));

    const result = await relayTypingSignal({
      user: { ...USER, isImpersonating: true },
      signal: 'started',
      logContext: {},
      resolvePostableConversationId: gate,
    });

    expect(result).toEqual({ success: false, error: TYPING_DENIED });
    expect(gate).not.toHaveBeenCalled();
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
  });

  it('a failed PUBLISH is a transport event: a WARNING with the action’s context, no stack', async () => {
    mockPublishTypingSignal.mockRejectedValue(new Error('ably down'));
    const logWarn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = await relayTypingSignal({
      user: USER,
      signal: 'started',
      logContext: { engagementId: 'e-1' },
      resolvePostableConversationId: () => Promise.resolve(GATE_CONVERSATION_ID),
    });

    expect(result).toEqual({ success: false, error: 'Could not send typing status.' });
    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('Typing signal not published', {
      engagementId: 'e-1',
      userId: USER.id,
      signal: 'started',
      error: 'ably down',
    });
  });

  it('a THROWING gate is a real fault: an ERROR with a stack — never an unhandled rejection', async () => {
    const logError = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = await relayTypingSignal({
      user: USER,
      signal: 'stopped',
      logContext: {},
      resolvePostableConversationId: () => Promise.reject(new Error('db down')),
    });

    expect(result).toEqual({ success: false, error: 'Could not send typing status.' });
    expect(mockPublishTypingSignal).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      'Failed to authorize typing signal',
      expect.objectContaining({ error: 'db down', stack: expect.any(String) })
    );
  });
});
