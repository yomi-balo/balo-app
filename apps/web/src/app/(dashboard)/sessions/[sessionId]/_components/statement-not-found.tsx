import { Receipt, ArrowUpRight } from 'lucide-react';
import { StatementNotice } from './statement-notice';
import { STATEMENT_COPY, STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/**
 * Shared NOT-FOUND content for BOTH `/receipt` and `/payout`. ONE copy that does not distinguish
 * missing / soft-deleted / unauthorised / wrong-lens — the body must never contain a word that
 * would confirm the session exists to a stranger.
 *
 * BAL-519 moved the centred-notice layout into `StatementNotice` so the new rate-limited state
 * could share it instead of cloning it. The rendered DOM is unchanged — `statement-not-found.test.tsx`
 * and both `route-states.test.tsx` a11y cases pass unmodified, which is the proof. The lens-derived
 * icon now lives here (not in `StatementNotice`) — the rate-limited state needs a different icon
 * for the same lens, so icon selection moved to each caller.
 */
export function StatementNotFound({
  lens,
}: Readonly<{ lens: 'client' | 'expert' }>): React.JSX.Element {
  return (
    <StatementNotice
      icon={lens === 'client' ? Receipt : ArrowUpRight}
      heading={STATEMENT_COPY[lens].notFoundHeading}
      body={STATEMENT_SHARED_COPY.notFoundBody}
      actionLabel={STATEMENT_SHARED_COPY.notFoundAction}
    />
  );
}
