import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { buildCalendarCards } from './build-your-move-cards';
import { readYourMoveData } from './read-your-move-data';
import { log } from '@/lib/logging';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import type { YourMoveCardView } from './your-move-view-types';

const NOW = new Date('2026-10-20T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readYourMoveData', () => {
  it('wraps a successful read as ready', async () => {
    const cards: YourMoveCardView[] = [];
    const rows = [{ id: 'p1' }] as PortfolioRowView[];
    const result = await readYourMoveData(() => Promise.resolve({ cards, rows }), {
      fallbackCards: [],
      logContext: { userId: 'u-1' },
    });
    expect(result).toEqual({ kind: 'ready', cards, rows });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a failed read and keeps the fallback cards', async () => {
    const result = await readYourMoveData(() => Promise.reject(new Error('db down')), {
      fallbackCards: buildCalendarCards({ calendarNeedsReconnect: true, now: NOW }),
      logContext: { userId: 'u-1' },
    });
    expect(result.kind).toBe('error');
    expect(result.cards.map((c) => c.kind)).toEqual(['calendar_reconnect']);
    expect(result.rows).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard your move read failed',
      expect.objectContaining({ userId: 'u-1', error: 'db down' })
    );
  });

  it('returns no cards on error when there are no fallback cards', async () => {
    const result = await readYourMoveData(() => Promise.reject('boom'), {
      fallbackCards: [],
      logContext: {},
    });
    expect(result).toEqual({ kind: 'error', cards: [], rows: [] });
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard your move read failed',
      expect.objectContaining({ error: 'boom' })
    );
  });
});
