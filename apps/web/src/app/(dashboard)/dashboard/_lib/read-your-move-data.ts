import 'server-only';

import { log } from '@/lib/logging';
import { buildCalendarCards } from './build-your-move-cards';
import type { YourMoveCardView, YourMoveData } from './your-move-view-types';

/**
 * The catch boundary for the Your move read. A failed read logs here and resolves to the error
 * state, but keeps the calendar blocker card: it needs no database read, and it must survive.
 */
export async function readYourMoveData(
  read: () => Promise<readonly YourMoveCardView[]>,
  input: {
    readonly calendarNeedsReconnect: boolean;
    readonly now?: Date;
    readonly logContext: Readonly<Record<string, string>>;
  }
): Promise<YourMoveData> {
  try {
    return { kind: 'ready', cards: await read() };
  } catch (error) {
    log.error('Dashboard your move read failed', {
      ...input.logContext,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      kind: 'error',
      cards: buildCalendarCards({
        calendarNeedsReconnect: input.calendarNeedsReconnect,
        now: input.now ?? new Date(),
      }),
    };
  }
}
