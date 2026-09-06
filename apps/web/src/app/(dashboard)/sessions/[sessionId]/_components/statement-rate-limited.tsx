import { Clock } from 'lucide-react';
import { StatementNotice } from './statement-notice';
import { STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/**
 * BAL-519 — shared RATE-LIMITED content for BOTH `/receipt` and `/payout`, rendered INLINE from
 * each page's `catch`. Nothing is wrong and nothing is missing: the reader simply asked for this
 * document faster than the api's per-user window allows.
 *
 * ⚠ A PLAIN SERVER COMPONENT, SHAPED LIKE `statement-not-found.tsx` — NOT LIKE `statement-error.tsx`.
 * The error one is `'use client'` and takes a `reset: () => void`; it is the route ERROR-BOUNDARY's
 * content and is unusable from a server page's `catch`. A 429 must never reach `error.tsx` at all,
 * whose copy ("this is on our side") would be a lie here.
 *
 * ⚠ NO COUNTDOWN, AND NO `retryAfterSeconds` PROP (D4). The api's cooldown rides on
 * `SessionStatementRateLimitedError` for the PDF route's `Retry-After` header only; this component
 * structurally cannot render it. Copy is shared by both lenses — only the icon and the retry
 * destination differ, per UX2 and UX1 of fix round 1.
 *
 * UX1 — the retry action actually retries: it links back to the SAME statement the reader was
 * trying to read (`/sessions/:id/receipt` or `/sessions/:id/payout`), not `/dashboard`. That is
 * also why `sessionId` is a required prop here even though `StatementNotFound` needs no such link.
 *
 * UX2 — `Clock`, not the lens-derived `Receipt` / `ArrowUpRight` icon `StatementNotFound` uses.
 * Same icon on both lenses: what distinguishes this state from not-found is that it is recoverable,
 * not which lens is viewing it.
 */
export function StatementRateLimited({
  lens,
  sessionId,
}: Readonly<{ lens: 'client' | 'expert'; sessionId: string }>): React.JSX.Element {
  const retryHref =
    lens === 'client' ? `/sessions/${sessionId}/receipt` : `/sessions/${sessionId}/payout`;
  return (
    <StatementNotice
      icon={Clock}
      heading={STATEMENT_SHARED_COPY.rateLimitedHeading}
      body={STATEMENT_SHARED_COPY.rateLimitedBody}
      actionLabel={STATEMENT_SHARED_COPY.rateLimitedAction}
      actionHref={retryHref}
    />
  );
}
