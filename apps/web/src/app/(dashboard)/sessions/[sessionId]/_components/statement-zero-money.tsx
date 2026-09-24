import { Ban } from 'lucide-react';
import { durationLine, type DurationLinePresence } from '@balo/shared/credit';
import type { SessionStatementView } from '../_lib/session-statement-view';
import { STATEMENT_COPY } from '../_lib/statement-copy';

/**
 * What `durationLine` needs to know about client-side presence. Only the client view carries it;
 * the expert's `missed_call` line names nobody, so that lens passes nothing.
 */
function presenceOf(view: SessionStatementView): DurationLinePresence | undefined {
  return view.lens === 'client' ? { clientSideEverPresent: view.clientSideEverPresent } : undefined;
}

/**
 * The non-monetary composition for `missed_call` / `abandoned_wait` (D-A) and the cancelled
 * state (BAL-441 owner Q1) — NO total, NO line items, NO `A$0.00` anywhere. A calm statement
 * region: a muted, non-money-implying icon chip + one heading-weight statement line.
 *
 * ⚠ `Ban`, never `Receipt` / `ArrowUpRight` — those icons imply a money outcome.
 */
export function StatementZeroMoney({
  view,
}: Readonly<{ view: SessionStatementView }>): React.JSX.Element {
  const line =
    view.mode.kind === 'cancelled'
      ? STATEMENT_COPY[view.lens].cancelledLine
      : durationLine(view.block, presenceOf(view));

  return (
    <div className="mt-8 flex flex-col items-center gap-3 py-6 text-center">
      <span
        aria-hidden="true"
        className="bg-muted text-muted-foreground inline-grid h-11 w-11 place-items-center rounded-full"
      >
        <Ban size={20} />
      </span>
      <p className="text-foreground text-base font-medium">{line}</p>
    </div>
  );
}
