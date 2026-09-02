import Link from 'next/link';
import { Receipt, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatementPageShell, StatementCard } from './statement-page-shell';
import { STATEMENT_COPY, STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/**
 * Shared NOT-FOUND content for BOTH `/receipt` and `/payout`. ONE copy that does not distinguish
 * missing / soft-deleted / unauthorised / wrong-lens — the body must never contain a word that
 * would confirm the session exists to a stranger.
 */
export function StatementNotFound({
  lens,
}: Readonly<{ lens: 'client' | 'expert' }>): React.JSX.Element {
  const copy = STATEMENT_COPY[lens];
  const Icon = lens === 'client' ? Receipt : ArrowUpRight;
  return (
    <StatementPageShell>
      <StatementCard>
        <div className="text-center">
          <span
            aria-hidden="true"
            className="bg-muted text-muted-foreground mb-4 inline-grid h-13 w-13 place-items-center rounded-xl"
          >
            <Icon className="h-6 w-6" />
          </span>
          <h1 className="text-foreground text-xl font-semibold">{copy.notFoundHeading}</h1>
          <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
            {STATEMENT_SHARED_COPY.notFoundBody}
          </p>
          <div className="mt-6 flex justify-center">
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/dashboard">{STATEMENT_SHARED_COPY.notFoundAction}</Link>
            </Button>
          </div>
        </div>
      </StatementCard>
    </StatementPageShell>
  );
}
