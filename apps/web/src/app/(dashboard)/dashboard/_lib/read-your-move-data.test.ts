import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { readYourMoveData } from './read-your-move-data';
import { log } from '@/lib/logging';
import type { YourMoveCardView } from './your-move-view-types';

const NOW = new Date('2026-10-20T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readYourMoveData', () => {
  it('wraps a successful read as ready', async () => {
    const cards: YourMoveCardView[] = [];
    const result = await readYourMoveData(() => Promise.resolve(cards), {
      calendarNeedsReconnect: false,
      logContext: { userId: 'u-1' },
    });
    expect(result).toEqual({ kind: 'ready', cards });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a failed read and keeps the calendar blocker', async () => {
    const result = await readYourMoveData(() => Promise.reject(new Error('db down')), {
      calendarNeedsReconnect: true,
      now: NOW,
      logContext: { userId: 'u-1' },
    });
    expect(result.kind).toBe('error');
    expect(result.cards.map((c) => c.kind)).toEqual(['calendar_reconnect']);
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard your move read failed',
      expect.objectContaining({ userId: 'u-1', error: 'db down' })
    );
  });

  it('returns no cards on error when the calendar is connected', async () => {
    const result = await readYourMoveData(() => Promise.reject('boom'), {
      calendarNeedsReconnect: false,
      logContext: {},
    });
    expect(result).toEqual({ kind: 'error', cards: [] });
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard your move read failed',
      expect.objectContaining({ error: 'boom' })
    );
  });
});
