import { StatementPageShell, StatementCard } from './statement-page-shell';
import { STATEMENT_COPY, STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/** Fixed literal key array — never an array index (SonarCloud S6479). */
const LINE_KEYS = ['a', 'b', 'c'] as const;

/**
 * Shared loading skeleton for BOTH `/receipt` and `/payout` — parameterised only by the
 * accessible label that differs. Matches the document's shape inside the same card outline, so
 * the layout does not jump on resolve. No back link during loading (avoids a flash of a link
 * that may resolve to null). Every pulsing span carries `motion-reduce:animate-none`.
 */
export function StatementSkeleton({
  lens,
}: Readonly<{ lens: 'client' | 'expert' }>): React.JSX.Element {
  return (
    <StatementPageShell>
      <StatementCard>
        {/* <output>, never role="status" (SonarCloud S6819) — <output> maps to role status. */}
        <output aria-label={STATEMENT_COPY[lens].loadingAriaLabel} className="block">
          <span className="bg-muted mb-2 block h-3 w-24 animate-pulse rounded motion-reduce:animate-none" />
          <span className="bg-muted mb-4 block h-6 w-2/3 animate-pulse rounded motion-reduce:animate-none" />
          <span className="bg-muted/60 mb-6 block h-3 w-1/2 animate-pulse rounded motion-reduce:animate-none" />
          <span className="bg-muted/40 mb-6 block h-20 w-full animate-pulse rounded-xl motion-reduce:animate-none" />
          {LINE_KEYS.map((key) => (
            <span
              key={key}
              className="bg-muted/60 mb-2 block h-3 w-full animate-pulse rounded motion-reduce:animate-none"
            />
          ))}
          <span className="sr-only">{STATEMENT_SHARED_COPY.loadingSrOnly}</span>
        </output>
      </StatementCard>
    </StatementPageShell>
  );
}
