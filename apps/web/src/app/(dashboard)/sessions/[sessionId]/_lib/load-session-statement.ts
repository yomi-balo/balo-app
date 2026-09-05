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
 * BAL-519 — thrown when the api's per-user limiter refused the statement read (`429`).
 *
 * ⚠ A DISTINCT CLASS, AND NEVER `null`. `null` means "denied" in this module and `notFound()`s the
 * page — which would tell a legitimate reader their receipt does not exist because they clicked
 * too fast. It is also not `SessionStatementUnavailableError`, whose destination is `error.tsx`
 * ("this is on our side"). Three causes, three outcomes.
 */
export class SessionStatementRateLimitedError extends Error {
  constructor(
    message: string,
    /**
     * From the api's 429 BODY (`cooldownSeconds`); `null` when it sent none. Carried for the PDF
     * route's `Retry-After` header ONLY — the page renders no countdown (D4).
     */
    public readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = 'SessionStatementRateLimitedError';
  }
}

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
    if (result.outcome === 'rate_limited') {
      throw new SessionStatementRateLimitedError(
        `Session statement rate-limited: ${sessionId}`,
        result.retryAfterSeconds
      );
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
