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
});
