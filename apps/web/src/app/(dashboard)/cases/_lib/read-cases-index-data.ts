import 'server-only';

import { log } from '@/lib/logging';
import type { CasesIndexData } from './cases-index-view-types';

/**
 * BAL-567 — THE ONE CATCH BOUNDARY between a failed read and a user-facing state
 * (`read-up-next-data.ts`'s shape).
 *
 * ⚠ THE `log.error` LIVES HERE, NOT INSIDE THE LOADER. This is the place that SWALLOWS the
 * error and returns `{ kind: 'error' }`, so without a log line the original failure — the SQL
 * error, the stack — would be gone for good (CLAUDE.md: "`log.error()` in every catch block that
 * returns a user-facing error").
 *
 * ⚠ IT TAKES A THUNK, not an already-started promise, so the read's own failure is caught rather
 * than surfacing as an unhandled rejection at the call site.
 *
 * ⚠ THE LOG CONTEXT CARRIES IDS ONLY. `requestId` and `userId` are attached automatically by the
 * AsyncLocalStorage mixin; nothing here logs a case title, a company name or anything a customer
 * wrote.
 */
export async function readCasesIndexData(
  read: () => Promise<CasesIndexData>,
  logContext: Readonly<Record<string, string>>
): Promise<CasesIndexData> {
  try {
    return await read();
  } catch (error) {
    log.error('Cases index read failed', {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { kind: 'error' };
  }
}
