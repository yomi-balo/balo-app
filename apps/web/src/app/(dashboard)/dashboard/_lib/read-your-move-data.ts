import 'server-only';

import { log } from '@/lib/logging';
import type { YourMoveCardView, YourMoveData } from './your-move-view-types';

/**
 * The catch boundary for the Your move read. A failed read logs here and resolves to the error
 * state, but keeps `fallbackCards`: cards that need no database read (the expert's calendar
 * blocker) must survive. The company rail passes none.
 */
export async function readYourMoveData(
  read: () => Promise<readonly YourMoveCardView[]>,
  input: {
    readonly fallbackCards: readonly YourMoveCardView[];
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
    return { kind: 'error', cards: input.fallbackCards };
  }
}
