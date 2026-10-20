import 'server-only';

import { log } from '@/lib/logging';
import type { YourMoveCardView, YourMoveRead, YourMoveReadData } from './your-move-view-types';

/**
 * The catch boundary for the Your move read. A failed read logs here and resolves to the error
 * state, but keeps `fallbackCards` (and no rows, so no track): cards that need no database
 * read (the expert's calendar blocker) must survive. The company rail passes none.
 */
export async function readYourMoveData(
  read: () => Promise<YourMoveRead>,
  input: {
    readonly fallbackCards: readonly YourMoveCardView[];
    readonly logContext: Readonly<Record<string, string>>;
  }
): Promise<YourMoveReadData> {
  try {
    const { cards, rows } = await read();
    return { kind: 'ready', cards, rows };
  } catch (error) {
    log.error('Dashboard your move read failed', {
      ...input.logContext,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { kind: 'error', cards: input.fallbackCards, rows: [] };
  }
}
