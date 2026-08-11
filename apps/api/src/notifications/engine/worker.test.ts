import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// Mock dependencies before imports
const mockResolveContext = vi.fn();
const mockDispatch = vi.fn();

vi.mock('./resolver.js', () => ({
  resolveContext: (...args: unknown[]) => mockResolveContext(...args),
}));

vi.mock('./dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

/**
 * ⚠ THE FOLLOW-UP MODULE MUST BE MOCKED. `scheduleConversationUnreadDigest` reaches
 * `scheduleNotification` → `@balo/db`, and the worker imports it at module scope: leaving it
 * real makes CI hang on a live Redis/Postgres connection.
 */
const mockScheduleDigest = vi.fn();
vi.mock('../scheduling/conversation-unread.js', () => ({
  scheduleConversationUnreadDigest: (...args: unknown[]) => mockScheduleDigest(...args),
}));

import { processNotificationEvent } from './worker.js';

function makeJob(data: Record<string, unknown>): Job {
  return { data } as unknown as Job;
}

describe('processNotificationEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveContext.mockResolvedValue({
      event: 'user.welcome',
      payload: { correlationId: 'c-1', userId: 'u-1' },
      data: { user: { id: 'u-1', email: 'a@b.com', firstName: 'Alice' } },
    });
  });

  it('resolves context and dispatches each rule for a known event', async () => {
    await processNotificationEvent(
      makeJob({
        event: 'user.welcome',
        payload: { correlationId: 'c-1', userId: 'u-1' },
        publishedAt: '2026-01-01T00:00:00Z',
      })
    );

    expect(mockResolveContext).toHaveBeenCalledWith('user.welcome', {
      correlationId: 'c-1',
      userId: 'u-1',
    });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it('skips dispatch when event has no rules', async () => {
    await processNotificationEvent(
      makeJob({
        event: 'unknown.event',
        payload: { correlationId: 'c-2' },
        publishedAt: '2026-01-01T00:00:00Z',
      })
    );

    expect(mockResolveContext).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('continues dispatching remaining rules when one throws', async () => {
    // Add a temporary second rule to test iteration continues
    const { notificationRules } = await import('./rules.js');
    const originalRules = notificationRules['user.welcome'];
    notificationRules['user.welcome'] = [
      ...originalRules!,
      {
        channel: 'email' as const,
        recipient: 'self' as const,
        template: 'welcome-2',
        timing: 'immediate' as const,
      },
    ];

    mockDispatch
      .mockRejectedValueOnce(new Error('dispatch failed'))
      .mockResolvedValueOnce(undefined);

    await processNotificationEvent(
      makeJob({
        event: 'user.welcome',
        payload: { correlationId: 'c-3', userId: 'u-1' },
        publishedAt: '2026-01-01T00:00:00Z',
      })
    );

    // Both rules should have been attempted
    expect(mockDispatch).toHaveBeenCalledTimes(2);

    // Restore
    notificationRules['user.welcome'] = originalRules!;
  });

  // ── BAL-424: the deferred follow-up hook ────────────────────────────
  describe('conversation unread digest follow-up', () => {
    function conversationJob(event: string, payload: Record<string, unknown>): Job {
      return makeJob({ event, payload, publishedAt: '2026-08-11T00:00:00Z' });
    }

    const clientPayload = {
      correlationId: 'm-1',
      conversationId: 'conv-1',
      contextType: 'relationship',
      contextId: 'rel-1',
      title: 'CPQ implementation',
      senderName: 'Priya',
      recipientRole: 'client',
      recipientId: 'user-client',
      projectRequestId: 'req-1',
      preview: 'hello',
      sentDuringMeeting: false,
    };

    beforeEach(() => {
      mockScheduleDigest.mockResolvedValue(undefined);
    });

    it('schedules the digest after dispatch, resolving the CLIENT recipient from the payload', async () => {
      mockResolveContext.mockResolvedValue({
        event: 'conversation.message_posted',
        payload: clientPayload,
        data: {},
      });
      await processNotificationEvent(conversationJob('conversation.message_posted', clientPayload));

      expect(mockDispatch).toHaveBeenCalled();
      expect(mockScheduleDigest).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          contextType: 'relationship',
          contextId: 'rel-1',
          recipientUserId: 'user-client',
          recipientRole: 'client',
          projectRequestId: 'req-1',
          preview: 'hello',
        })
      );
    });

    /**
     * ⚠ THIS IS WHY THE HOOK RUNS AFTER `resolveContext`. The expert arm carries an
     * `expertProfileId` on the wire; the recheck reads `conversation_read_states` by
     * (conversation, USER) and cannot hydrate a profile inside the guard.
     */
    it('resolves the EXPERT recipient from the hydrated data.expert.user.id', async () => {
      const expertPayload = {
        ...clientPayload,
        recipientRole: 'expert',
        recipientId: undefined,
        expertProfileId: 'exp-1',
      };
      mockResolveContext.mockResolvedValue({
        event: 'conversation.message_posted',
        payload: expertPayload,
        data: { expert: { user: { id: 'user-expert' } } },
      });
      await processNotificationEvent(conversationJob('conversation.message_posted', expertPayload));

      expect(mockScheduleDigest).toHaveBeenCalledWith(
        expect.objectContaining({ recipientUserId: 'user-expert', recipientRole: 'expert' })
      );
    });

    /**
     * ⚠⚠ BOTH EVENTS DISPATCH TO THE SAME HELPER — which uses the same dedupe key. That is
     * what makes a message plus a file inside one 10-minute window ONE email.
     */
    it('routes conversation.file_shared to the SAME helper, seeding fileName not preview', async () => {
      const filePayload = {
        ...clientPayload,
        correlationId: 'f-1',
        preview: undefined,
        fileName: 'price-book.xlsx',
      };
      mockResolveContext.mockResolvedValue({
        event: 'conversation.file_shared',
        payload: filePayload,
        data: {},
      });
      await processNotificationEvent(conversationJob('conversation.file_shared', filePayload));

      expect(mockScheduleDigest).toHaveBeenCalledTimes(1);
      const [input] = mockScheduleDigest.mock.calls[0] ?? [];
      expect(input).toMatchObject({ conversationId: 'conv-1', fileName: 'price-book.xlsx' });
      expect(input).not.toHaveProperty('preview');
    });

    it('does not schedule when the recipient cannot be resolved', async () => {
      const orphan = { ...clientPayload, recipientId: undefined };
      mockResolveContext.mockResolvedValue({
        event: 'conversation.message_posted',
        payload: orphan,
        data: {},
      });
      await processNotificationEvent(conversationJob('conversation.message_posted', orphan));
      expect(mockScheduleDigest).not.toHaveBeenCalled();
    });

    /** A scheduling hiccup must never fail the immediate in-app notification. */
    it('swallows a throwing follow-up', async () => {
      mockScheduleDigest.mockRejectedValue(new Error('redis down'));
      mockResolveContext.mockResolvedValue({
        event: 'conversation.message_posted',
        payload: clientPayload,
        data: {},
      });
      await expect(
        processNotificationEvent(conversationJob('conversation.message_posted', clientPayload))
      ).resolves.toBeUndefined();
      expect(mockDispatch).toHaveBeenCalled();
    });

    it('never fires a follow-up for an unrelated event', async () => {
      await processNotificationEvent(
        makeJob({
          event: 'user.welcome',
          payload: { correlationId: 'c-1', userId: 'u-1' },
          publishedAt: '2026-01-01T00:00:00Z',
        })
      );
      expect(mockScheduleDigest).not.toHaveBeenCalled();
    });
  });
});
