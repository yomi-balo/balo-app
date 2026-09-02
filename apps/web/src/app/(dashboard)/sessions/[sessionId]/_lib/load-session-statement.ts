import 'server-only';

import { cache } from 'react';
import { fetchSessionStatement } from '@/lib/api/session-statement';
import { toSessionStatementView, type SessionStatementView } from './session-statement-view';

/**
 * BAL-441 — thrown for a 5xx / transport failure ONLY. The page logs and re-throws this into
 * `error.tsx`. Never thrown for a denial (missing / soft-deleted / unauthorised / wrong-lens) —
 * those all resolve to `null` (below), so the page's ONE `notFound()` has one copy.
 */
export class SessionStatementUnavailableError extends Error {}

/**
 * Load + lens-assert the session statement, `cache()`'d so `generateMetadata`'s full-gate
 * re-run is free (mirrors `loadCase` / `loadRecap`).
 *
 * `null` for EVERY denial — missing, soft-deleted, unauthorised, wrong lens — ONE copy. The api
 * already 404s a stranger; THE WRONG-LENS ASSERTION LIVES HERE, not in the page: a client who
 * opens `/payout` (or an expert who opens `/receipt`) gets the identical `null` → `notFound()`
 * outcome as a stranger, so the two are indistinguishable on the wire.
 */
export const loadSessionStatement = cache(
  // ⚠ `userId` is UNUSED here — the api call resolves the acting principal from the
  // iron-session server-side (`callSessionApi`). Accepted as a parameter anyway for symmetry
  // with the other entity loaders (`loadCase`, `loadRecap`) and because a future direct-DB path
  // would need it.
  async (
    sessionId: string,
    _userId: string,
    lens: 'client' | 'expert'
  ): Promise<SessionStatementView | null> => {
    const result = await fetchSessionStatement(sessionId);
    if (result.outcome === 'unavailable') {
      throw new SessionStatementUnavailableError(`Session statement unavailable: ${sessionId}`);
    }
    if (result.outcome === 'denied') {
      return null;
    }
    if (result.statement.lens !== lens) {
      return null;
    }
    return toSessionStatementView(result.statement);
  }
);
