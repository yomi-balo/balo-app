import { durationLine, finalizedAmountMinor } from '@balo/shared/credit';
import { formatAud } from '@/lib/credit/display-constants';
import type { SessionStatementView } from '../_lib/session-statement-view';
import { STATEMENT_COPY, STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

interface RowProps {
  label: string;
  value: string;
  subLine?: string | null;
}

function StatementRow({ label, value, subLine = null }: Readonly<RowProps>): React.JSX.Element {
  return (
    // ⚠ `<dt>` AND `<dd>` MUST BE DIRECT CHILDREN of the wrapping `<div>`. A `<dl>` may contain
    // `<div>` groups, but each group must hold the `dt`/`dd` pair DIRECTLY — an extra nested
    // `<div>` around the `<dt>` (which is what this was) breaks definition-list semantics, and a
    // screen reader stops announcing the receipt's rows as label/value pairs at all. Caught by
    // the `axe` matrix in `statement-shell.test.tsx`; it failed ONLY on the money compositions,
    // because they are the only ones with line items. The sub-line lives INSIDE the `<dt>` (which
    // accepts flow content) rather than as a third sibling.
    <div className="border-border/60 flex items-baseline justify-between gap-4 border-b py-2.5">
      <dt className="text-muted-foreground text-sm">
        {label}
        {subLine !== null && <span className="mt-0.5 block text-xs">{subLine}</span>}
      </dt>
      <dd className="text-foreground font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function StatementTotalRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="border-foreground/20 mt-1 flex items-baseline justify-between gap-4 border-t-2 pt-3">
      <dt className="text-foreground text-sm font-semibold">{label}</dt>
      <dd className="text-foreground font-mono text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The two-column statement + total (§9 of the plan). Client gets a `ratePerMinuteMinor` row;
 * expert does not — `ratePerMinuteMinor` is not part of the expert lens payload and is
 * DELIBERATELY never back-computed from `earnings ÷ duration` (that would invent a number the
 * api never asserted and drift the moment the floor or rounding is involved).
 */
export function StatementLineItems({
  view,
}: Readonly<{ view: SessionStatementView }>): React.JSX.Element {
  const copy = STATEMENT_COPY[view.lens];
  const line = durationLine(view.block);
  const bareDuration = `${view.block.durationMinutes} min`;
  const subLine = line === bareDuration ? null : line;
  const total = finalizedAmountMinor(view.block);

  return (
    <dl className="mt-6">
      {view.lens === 'client' && (
        <StatementRow
          label={STATEMENT_SHARED_COPY.rateRowLabel}
          value={formatAud(view.block.ratePerMinuteMinor)}
        />
      )}
      <StatementRow label={copy.durationRowLabel} value={bareDuration} subLine={subLine} />
      <StatementTotalRow label={copy.totalRowLabel} value={formatAud(total)} />
    </dl>
  );
}
